import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parse,
  type DefinitionNode,
  type FieldDefinitionNode,
  type InputObjectTypeDefinitionNode,
  type InputObjectTypeExtensionNode,
  type InputValueDefinitionNode,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  type TypeNode,
} from 'graphql';
import { DEFAULT_IGNORE } from '../next/index.js';
import type { GraphQLOperation } from '../../types.js';

interface GraphQLScanOptions {
  cwd: string;
  schemaPath?: string;
  exclude?: string[];
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

  const parsedCandidates: { sourceFile: string; definitions: readonly DefinitionNode[] }[] = [];
  const globalDefinitions: DefinitionNode[] = [];

  for (const candidate of candidates) {
    try {
      const document = parse(candidate.sdl);
      parsedCandidates.push({ sourceFile: candidate.sourceFile, definitions: document.definitions });
      globalDefinitions.push(...document.definitions);
    } catch (error) {
      warnings.push(`No se pudo parsear GraphQL en ${candidate.sourceFile}: ${String(error)}`);
    }
  }

  const roots = rootTypeNames(globalDefinitions);
  for (const candidate of parsedCandidates) {
    operations.push(...extractOperations(candidate.definitions, globalDefinitions, candidate.sourceFile, roots));
  }

  return { operations, warnings };
}

async function findSchemaCandidates(options: GraphQLScanOptions, warnings: string[]): Promise<SchemaCandidate[]> {
  if (options.schemaPath) {
    const absolutePath = path.resolve(options.cwd, options.schemaPath);
    return [{ sourceFile: path.relative(options.cwd, absolutePath).replace(/\\/g, '/'), sdl: await readFile(absolutePath, 'utf-8') }];
  }

  const ignore = [...DEFAULT_IGNORE, ...(options.exclude ?? [])];

  const [schemaFiles, tsFiles] = await Promise.all([
    fg(['**/*.{graphql,gql}'], {
      cwd: options.cwd,
      absolute: true,
      ignore,
    }),
    fg(['**/*.{ts,tsx,js,jsx}'], {
      cwd: options.cwd,
      absolute: true,
      ignore,
    })
  ]);

  const candidates: SchemaCandidate[] = [];

  for (const file of schemaFiles) {
    candidates.push({
      sourceFile: path.relative(options.cwd, file).replace(/\\/g, '/'),
      sdl: await readFile(file, 'utf-8'),
    });
  }

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

type ObjectLike = ObjectTypeDefinitionNode | ObjectTypeExtensionNode;
type InputObjectLike = InputObjectTypeDefinitionNode | InputObjectTypeExtensionNode;

function isObjectLike(definition: DefinitionNode): definition is ObjectLike {
  return definition.kind === 'ObjectTypeDefinition' || definition.kind === 'ObjectTypeExtension';
}

/** Nombres de los tipos raíz, respetando `schema { query: RootQuery }`. */
function rootTypeNames(definitions: readonly DefinitionNode[]) {
  const roots = { query: 'Query', mutation: 'Mutation' };
  for (const definition of definitions) {
    if (definition.kind !== 'SchemaDefinition' && definition.kind !== 'SchemaExtension') continue;
    for (const operation of definition.operationTypes ?? []) {
      if (operation.operation === 'query') roots.query = operation.type.name.value;
      if (operation.operation === 'mutation') roots.mutation = operation.type.name.value;
    }
  }
  return roots;
}

function extractOperations(
  definitions: readonly DefinitionNode[],
  globalDefinitions: readonly DefinitionNode[],
  sourceFile: string,
  roots: { query: string; mutation: string },
): GraphQLOperation[] {
  const objectTypes = definitions.filter(isObjectLike);
  const fieldsOf = (name: string) => objectTypes
    .filter((type) => type.name.value === name)
    .flatMap((type) => type.fields ?? []);

  return [
    ...fieldsToOperations('query', fieldsOf(roots.query), globalDefinitions, sourceFile),
    ...fieldsToOperations('mutation', fieldsOf(roots.mutation), globalDefinitions, sourceFile),
  ];
}

function fieldsToOperations(
  operationType: 'query' | 'mutation',
  fields: readonly FieldDefinitionNode[],
  globalDefinitions: readonly DefinitionNode[],
  sourceFile: string,
): GraphQLOperation[] {
  return fields.map((field) => {
    const args = field.arguments?.map((argument) => ({
      name: argument.name.value,
      type: typeToString(argument.type),
      required: argument.type.kind === 'NonNullType',
    })) ?? [];
    const variables = Object.fromEntries(
      (field.arguments ?? []).map((argument) => [argument.name.value, sampleValueForType(argument.type, globalDefinitions)]),
    );
    const variableDefinitions = args.length > 0
      ? `(${args.map((arg) => `$${arg.name}: ${arg.type}`).join(', ')})`
      : '';
    const fieldArguments = args.length > 0
      ? `(${args.map((arg) => `${arg.name}: $${arg.name}`).join(', ')})`
      : '';
    
    const returnTypeName = typeToString(field.type).replace(/[!\[\]]/g, '');
    const isScalar = isScalarType(returnTypeName) ||
      globalDefinitions.some((def) => def.kind === 'ScalarTypeDefinition' && def.name.value === returnTypeName);

    let selection = '';
    if (!isScalar) {
      const objFields = globalDefinitions
        .filter((def): def is ObjectLike => isObjectLike(def) && def.name.value === returnTypeName)
        .flatMap((def) => def.fields ?? []);
      const objType = objFields.length > 0 ? { fields: objFields } : undefined;

      if (objType) {
        const hasId = objType.fields?.some((f) => f.name.value === 'id');
        if (hasId) {
          selection = ' { id }';
        } else {
          const firstScalar = objType.fields?.find((f) => {
            const fieldTypeName = typeToString(f.type).replace(/[!\[\]]/g, '');
            return isScalarType(fieldTypeName) ||
              globalDefinitions.some((def) => def.kind === 'ScalarTypeDefinition' && def.name.value === fieldTypeName);
          });

          if (firstScalar) {
            selection = ` { ${firstScalar.name.value} }`;
          } else if (objType.fields && objType.fields.length > 0) {
            selection = ` { ${objType.fields[0].name.value} }`;
          }
        }
      } else {
        selection = ' { id }';
      }
    }

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

function sampleValueForType(type: TypeNode, definitions: readonly DefinitionNode[], depth = 0): unknown {
  if (type.kind === 'NonNullType') return sampleValueForType(type.type, definitions, depth);
  if (type.kind === 'ListType') return [sampleValueForType(type.type, definitions, depth)];

  const name = type.name.value;
  if (name === 'Int' || name === 'Float') return 0;
  if (name === 'Boolean') return true;
  if (name === 'ID') return 'id';
  if (name === 'String') return 'string';

  const enumType = definitions.find((def) => def.kind === 'EnumTypeDefinition' && def.name.value === name);
  if (enumType && enumType.kind === 'EnumTypeDefinition') return enumType.values?.[0]?.name.value ?? 'string';

  if (depth < 4) {
    const inputFields = definitions
      .filter((def): def is InputObjectLike => (def.kind === 'InputObjectTypeDefinition' || def.kind === 'InputObjectTypeExtension') && def.name.value === name)
      .flatMap((def): readonly InputValueDefinitionNode[] => def.fields ?? []);
    if (inputFields.length > 0) {
      return Object.fromEntries(inputFields.map((field) => [field.name.value, sampleValueForType(field.type, definitions, depth + 1)]));
    }
  }

  return 'string';
}

function isScalarType(type: string): boolean {
  const normalized = type.replace(/[!\[\]]/g, '');
  return ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(normalized);
}
