import fg from 'fast-glob';
import path from 'node:path';
import type { Endpoint, HttpMethod, JsonSchema, MethodMetadata } from '../../types.js';
import type { AdapterOptions, AdapterResult } from '../index.js';
import { objectLiteralProps, parseLiteralValue, parseStringLiteral, splitTopLevel } from '../shared/code.js';
import {
  type ClassMember,
  type Decorator,
  findDecoratedClasses,
  readDecorators,
  scanClassMembers,
  typeTextToSchema,
} from '../shared/classes.js';
import { normalizeRoutePath, routeParamsOf } from '../shared/handler.js';
import { inferHeaders, inferQueryParams } from '../shared/request.js';
import { SourceLoader } from '../shared/source.js';
import { exampleFromSchema, inferZodBody, resolveSchemaByName } from '../shared/zod.js';
import { SOURCE_IGNORE } from '../express/index.js';

const HTTP_DECORATORS: Record<string, HttpMethod[]> = {
  Get: ['GET'],
  Post: ['POST'],
  Put: ['PUT'],
  Patch: ['PATCH'],
  Delete: ['DELETE'],
  Head: ['HEAD'],
  Options: ['OPTIONS'],
  All: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
};

const BODY_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH'];
const AUTH_GUARD = /auth|jwt|guard|passport|session|bearer/i;
const PUBLIC_DECORATORS = new Set(['Public', 'SkipAuth', 'AllowAnonymous', 'IsPublic', 'NoAuth']);

interface AppSettings {
  globalPrefix: string;
  /** Prefijo de versión por URI (`v`) o `null` si el versionado por URI no está activo. */
  versionPrefix: string | null;
  defaultVersion: string | null;
  graphqlPath: string | null;
  graphqlSource: string;
}

/** Lee `setGlobalPrefix`, `enableVersioning` y `GraphQLModule.forRoot` en todo el proyecto. */
function readAppSettings(sources: { file: string; code: string }[]): AppSettings {
  const settings: AppSettings = { globalPrefix: '', versionPrefix: null, defaultVersion: null, graphqlPath: null, graphqlSource: '' };

  for (const { file, code } of sources) {
    const prefix = /setGlobalPrefix\s*\(\s*(['"`])([^'"`]*)\1/.exec(code);
    if (prefix) settings.globalPrefix = prefix[2];

    const versioning = /enableVersioning\s*\(\s*(\{[\s\S]*?\})\s*\)/.exec(code);
    if (versioning && /VersioningType\s*\.\s*URI/.test(versioning[1])) {
      const props = objectLiteralProps(versioning[1]);
      const customPrefix = props.get('prefix');
      settings.versionPrefix = customPrefix === 'false' ? '' : parseStringLiteral(customPrefix ?? '') ?? 'v';
      const defaultVersion = parseLiteralValue(props.get('defaultVersion') ?? '');
      if (typeof defaultVersion === 'string' || typeof defaultVersion === 'number') settings.defaultVersion = String(defaultVersion);
    }

    if (/GraphQLModule\s*\.\s*forRoot(?:Async)?\s*[<(]/.test(code)) {
      const graphqlPath = /GraphQLModule[\s\S]*?\bpath\s*:\s*(['"`])([^'"`]+)\1/.exec(code);
      settings.graphqlPath = graphqlPath?.[2] ?? '/graphql';
      settings.graphqlSource = file;
    }
  }
  return settings;
}

function pathsFromDecorator(args: string): string[] {
  const first = splitTopLevel(args)[0]?.trim();
  if (!first) return [''];
  const literal = parseLiteralValue(first);
  if (typeof literal === 'string') return [literal];
  if (Array.isArray(literal)) return literal.filter((item): item is string => typeof item === 'string');
  if (first.startsWith('{')) {
    const props = objectLiteralProps(first);
    const value = parseLiteralValue(props.get('path') ?? "''");
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  }
  return [''];
}

function versionFromDecorators(decorators: Decorator[], controllerArgs?: string): string | null {
  const version = decorators.find((decorator) => decorator.name === 'Version');
  if (version) {
    if (version.args.includes('VERSION_NEUTRAL')) return 'VERSION_NEUTRAL';
    const value = parseLiteralValue(splitTopLevel(version.args)[0] ?? '');
    return Array.isArray(value) ? String(value[0]) : value !== undefined ? String(value) : null;
  }
  const first = controllerArgs ? splitTopLevel(controllerArgs)[0]?.trim() : undefined;
  if (first?.startsWith('{')) {
    const raw = objectLiteralProps(first).get('version') ?? '';
    if (raw.includes('VERSION_NEUTRAL')) return 'VERSION_NEUTRAL';
    const value = parseLiteralValue(raw);
    if (Array.isArray(value)) return String(value[0]);
    if (value !== undefined) return String(value);
  }
  return null;
}

function requiresAuth(decorators: Decorator[]): boolean | null {
  if (decorators.some((decorator) => PUBLIC_DECORATORS.has(decorator.name))) return false;
  if (decorators.some((decorator) => decorator.name === 'ApiBearerAuth')) return true;
  if (decorators.some((decorator) => ['UseGuards', 'Auth', 'Authorized', 'Roles'].includes(decorator.name) && (decorator.name !== 'UseGuards' || AUTH_GUARD.test(decorator.args)))) return true;
  return null;
}

interface Param {
  decorators: Decorator[];
  name: string;
  type?: string;
}

function parseParams(params: string): Param[] {
  return splitTopLevel(params).map((raw) => {
    const { decorators, end } = readDecorators(raw, 0);
    const rest = raw.slice(end).replace(/^(?:(?:public|private|protected|readonly)\s+)+/, '');
    const match = /^([\w$]+)\??\s*(?::\s*([\s\S]+?))?(?:=[\s\S]*)?$/.exec(rest.trim());
    return { decorators, name: match?.[1] ?? '', type: match?.[2]?.trim() };
  });
}

/** Schema Zod pasado a un pipe: `new ZodValidationPipe(createUserSchema)`. */
function zodPipeSchemaName(text: string): string | null {
  return /ZodValidationPipe\s*\(\s*([\w$]+)\s*\)/.exec(text)?.[1] ?? null;
}

async function inferMethodMetadata(
  member: ClassMember,
  method: HttpMethod,
  routePath: string,
  auth: boolean,
  filePath: string,
  loader: SourceLoader,
): Promise<MethodMetadata | undefined> {
  const headers: string[] = auth ? ['Authorization'] : [];
  const query: string[] = [];
  const routeParams = routeParamsOf(routePath);
  const ctx = { filePath, loader, depth: 0 };
  let bodySchema: JsonSchema | null = null;
  const bodyFields: Record<string, JsonSchema> = {};

  const addHeader = (name: string) => {
    const canonical = name.toLowerCase() === 'authorization' ? 'Authorization' : name;
    if (!headers.some((header) => header.toLowerCase() === canonical.toLowerCase())) headers.push(canonical);
  };
  const addQuery = (name: string) => {
    if (!routeParams.has(name) && !query.includes(name)) query.push(name);
  };

  for (const param of parseParams(member.params ?? '')) {
    for (const decorator of param.decorators) {
      const key = splitTopLevel(decorator.args).map(parseStringLiteral).find((value): value is string => value !== null);

      if (decorator.name === 'Headers' && key) addHeader(key);

      if (decorator.name === 'Query') {
        if (key) addQuery(key);
        else if (param.type) {
          const schema = await typeTextToSchema(param.type, ctx);
          Object.keys(schema.schema.properties ?? {}).forEach(addQuery);
        }
      }

      if (decorator.name === 'Body' && BODY_METHODS.includes(method)) {
        const pipeSchema = zodPipeSchemaName(decorator.args);
        if (pipeSchema) {
          bodySchema = await resolveSchemaByName(pipeSchema, filePath, loader);
        } else if (key) {
          bodyFields[key] = param.type ? (await typeTextToSchema(param.type, ctx)).schema : {};
        } else if (param.type) {
          const schema = (await typeTextToSchema(param.type, ctx)).schema;
          if (schema.properties || schema.type) bodySchema = schema;
        }
      }
    }
  }

  const pipes = member.decorators.find((decorator) => decorator.name === 'UsePipes');
  const pipeName = pipes ? zodPipeSchemaName(pipes.args) : null;
  if (!bodySchema && pipeName && BODY_METHODS.includes(method)) {
    bodySchema = await resolveSchemaByName(pipeName, filePath, loader);
  }
  if (!bodySchema && Object.keys(bodyFields).length > 0) {
    bodySchema = { type: 'object', properties: bodyFields, required: Object.keys(bodyFields) };
  }

  if (member.body) {
    inferHeaders(member.body).forEach(addHeader);
    inferQueryParams(member.body).forEach(addQuery);
    if (!bodySchema && BODY_METHODS.includes(method)) {
      bodySchema = (await inferZodBody(member.body, filePath, loader))?.schema ?? null;
    }
  }

  const meta: MethodMetadata = {};
  if (headers.length > 0) meta.headers = headers;
  if (query.length > 0) meta.query = query;
  if (bodySchema) {
    meta.bodySchema = bodySchema;
    meta.body = JSON.stringify(exampleFromSchema(bodySchema), null, 2);
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export async function scanNestRoutes(options: AdapterOptions): Promise<AdapterResult> {
  const cwd = path.resolve(options.cwd);
  const loader = new SourceLoader(cwd);
  const files = await fg(['**/*.{ts,mts,js}'], { cwd, ignore: [...SOURCE_IGNORE, ...(options.exclude ?? [])] });

  const sources: { file: string; absolute: string; code: string }[] = [];
  for (const file of files) {
    const absolute = path.join(cwd, file);
    const code = await loader.load(absolute);
    if (code && /@Controller\s*\(|setGlobalPrefix|enableVersioning|GraphQLModule/.test(code)) sources.push({ file, absolute, code });
  }

  const settings = readAppSettings(sources);
  const endpoints = new Map<string, Endpoint>();

  for (const source of sources) {
    for (const controller of findDecoratedClasses(source.code, 'Controller')) {
      const controllerDecorator = controller.decorators.find((decorator) => decorator.name === 'Controller')!;
      const controllerPaths = pathsFromDecorator(controllerDecorator.args);
      const controllerAuth = requiresAuth(controller.decorators) ?? false;
      const controllerVersion = versionFromDecorators(controller.decorators, controllerDecorator.args);

      for (const member of scanClassMembers(controller.body)) {
        if (member.kind !== 'method') continue;
        const httpDecorator = member.decorators.find((decorator) => HTTP_DECORATORS[decorator.name]);
        if (!httpDecorator) continue;

        const methods = HTTP_DECORATORS[httpDecorator.name];
        const methodAuth = requiresAuth(member.decorators);
        const auth = methodAuth ?? controllerAuth;
        const version = versionFromDecorators(member.decorators) ?? controllerVersion ?? settings.defaultVersion;
        const versionSegment = settings.versionPrefix !== null && version && version !== 'VERSION_NEUTRAL'
          ? `${settings.versionPrefix}${version}`
          : '';

        for (const controllerPath of controllerPaths) {
          for (const methodPath of pathsFromDecorator(httpDecorator.args)) {
            const routePath = normalizeRoutePath(settings.globalPrefix, versionSegment, controllerPath, methodPath);
            const key = `${routePath} ${source.file}`;
            const endpoint = endpoints.get(key) ?? { path: routePath, methods: [], fileType: 'rest' as const, sourceFile: source.file, router: 'nestjs' as const };
            endpoints.set(key, endpoint);

            for (const method of methods) {
              if (endpoint.methods.includes(method)) continue;
              endpoint.methods.push(method);
              const meta = await inferMethodMetadata(member, method, routePath, auth, source.absolute, loader);
              if (meta) endpoint.methodsMetadata = { ...endpoint.methodsMetadata, [method]: meta };
            }
          }
        }
      }
    }
  }

  const result = [...endpoints.values()];
  if (settings.graphqlPath) {
    result.push({
      path: normalizeRoutePath(settings.graphqlPath),
      methods: ['POST'],
      fileType: 'graphql',
      sourceFile: settings.graphqlSource,
      router: 'nestjs',
    });
  }

  return { endpoints: result.sort((a, b) => a.path.localeCompare(b.path)), warnings: [] };
}
