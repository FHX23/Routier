import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, type DefinitionNode, type FieldDefinitionNode, type ObjectTypeDefinitionNode, type TypeNode } from 'graphql';
import type { GraphQLOperation } from '../../types.js';

interface GraphQLScanOptions {
  cwd: string;
  schemaPath?: string;
}

interface GraphQLScanResult {
  operations: GraphQLOperation[];
  warnings: string[];
}

interface SchemaCandidate {
  sourceFile: string;
  sdl: string;
}

export async function scanGraphQLSchema(options: GraphQLScanOptions): Promise<GraphQLScanResult> {
  const warnings: string[] = [];
  const candidates = await findSchemaCandidates(options, warnings);
  const operations: GraphQLOperation[] = [];

  for (const candidate of candidates) {
    try {
      const document = parse(candidate.sdl);
      operations.push(...extractOperations(document.definitions, candidate.sourceFile));
    } catch (error) {
      warnings.push(`No se pudo parsear GraphQL en ${candidate.sourceFile}: ${String(error)}`);
    }
  }

  return { operations, warnings };
}

async function findSchemaCandidates(options: GraphQLScanOptions, warnings: string[]): Promise<SchemaCandidate[]> {
  if (options.schemaPath) {
    const absolutePath = path.resolve(options.cwd, options.schemaPath);
    return [{ sourceFile: path.relative(options.cwd, absolutePath).replace(/\\/g, '/'), sdl: await readFile(absolutePath, 'utf-8') }];
  }

  const schemaFiles = await fg(['**/*.{graphql,gql}'], {
    cwd: options.cwd,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/routier-exports/**'],
  });

  if (schemaFiles.length > 0) {
    return Promise.all(schemaFiles.map(async (file) => ({
      sourceFile: path.relative(options.cwd, file).replace(/\\/g, '/'),
      sdl: await readFile(file, 'utf-8'),
    })));
  }

  const tsFiles = await fg(['**/*.{ts,tsx,js,jsx}'], {
    cwd: options.cwd,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/routier-exports/**'],
  });

  const candidates: SchemaCandidate[] = [];

  for (const file of tsFiles) {
    const content = await readFile(file, 'utf-8');
    const sourceFile = path.relative(options.cwd, file).replace(/\\/g, '/');
    const extracted = extractStaticSdlFromCode(content, sourceFile, warnings);
    candidates.push(...extracted.map((sdl) => ({ sourceFile, sdl })));
  }

  return candidates;
}

function extractStaticSdlFromCode(content: string, sourceFile: string, warnings: string[]): string[] {
  const schemas: string[] = [];
  const patterns = [
    /\bgql\s*`([\s\S]*?)`/g,
    /\btypeDefs\s*=\s*`([\s\S]*?)`/g,
    /\btypeDefs\s*:\s*`([\s\S]*?)`/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const sdl = match[1] ?? '';
      if (sdl.includes('${')) {
        warnings.push(`Schema GraphQL dinamico omitido en ${sourceFile}.`);
        continue;
      }
      schemas.push(sdl);
    }
  }

  return schemas;
}

function extractOperations(definitions: readonly DefinitionNode[], sourceFile: string): GraphQLOperation[] {
  const objectTypes = definitions.filter((definition): definition is ObjectTypeDefinitionNode => definition.kind === 'ObjectTypeDefinition');
  const queryType = objectTypes.find((type) => type.name.value === 'Query');
  const mutationType = objectTypes.find((type) => type.name.value === 'Mutation');

  return [
    ...fieldsToOperations('query', queryType?.fields ?? [], sourceFile),
    ...fieldsToOperations('mutation', mutationType?.fields ?? [], sourceFile),
  ];
}

function fieldsToOperations(
  operationType: 'query' | 'mutation',
  fields: readonly FieldDefinitionNode[],
  sourceFile: string,
): GraphQLOperation[] {
  return fields.map((field) => {
    const args = field.arguments?.map((argument) => ({
      name: argument.name.value,
      type: typeToString(argument.type),
      required: argument.type.kind === 'NonNullType',
    })) ?? [];
    const variables = Object.fromEntries(args.map((arg) => [arg.name, sampleValueForType(arg.type)]));
    const variableDefinitions = args.length > 0
      ? `(${args.map((arg) => `$${arg.name}: ${arg.type}`).join(', ')})`
      : '';
    const fieldArguments = args.length > 0
      ? `(${args.map((arg) => `${arg.name}: $${arg.name}`).join(', ')})`
      : '';
    const selection = isScalarType(typeToString(field.type)) ? '' : ' { id }';
    const query = `${operationType} ${field.name.value}${variableDefinitions} { ${field.name.value}${fieldArguments}${selection} }`;

    return {
      type: operationType,
      name: field.name.value,
      arguments: args,
      variables,
      body: { query, variables },
      sourceFile,
    };
  });
}

function typeToString(type: TypeNode): string {
  if (type.kind === 'NonNullType') return `${typeToString(type.type)}!`;
  if (type.kind === 'ListType') return `[${typeToString(type.type)}]`;
  return type.name.value;
}

function sampleValueForType(type: string): unknown {
  const normalized = type.replace(/[!\[\]]/g, '');
  if (normalized === 'Int' || normalized === 'Float') return 0;
  if (normalized === 'Boolean') return true;
  if (normalized === 'ID') return 'id';
  return 'string';
}

function isScalarType(type: string): boolean {
  const normalized = type.replace(/[!\[\]]/g, '');
  return ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(normalized);
}
