import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, type DefinitionNode, type FieldDefinitionNode, type ObjectTypeDefinitionNode, type TypeNode } from 'graphql';
import type { GraphQLOperation } from '../../types.js';

interface GraphQLScanOptions {
  cwd: string;
  schemaPath?: string;
  exclude?: string[];
}

const DEFAULT_IGNORE = ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/routier-exports/**'];


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

  for (const candidate of parsedCandidates) {
    operations.push(...extractOperations(candidate.definitions, globalDefinitions, candidate.sourceFile));
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

function extractOperations(
  definitions: readonly DefinitionNode[],
  globalDefinitions: readonly DefinitionNode[],
  sourceFile: string,
): GraphQLOperation[] {
  const objectTypes = definitions.filter((definition): definition is ObjectTypeDefinitionNode => definition.kind === 'ObjectTypeDefinition');
  const queryType = objectTypes.find((type) => type.name.value === 'Query');
  const mutationType = objectTypes.find((type) => type.name.value === 'Mutation');

  return [
    ...fieldsToOperations('query', queryType?.fields ?? [], globalDefinitions, sourceFile),
    ...fieldsToOperations('mutation', mutationType?.fields ?? [], globalDefinitions, sourceFile),
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
    const variables = Object.fromEntries(args.map((arg) => [arg.name, sampleValueForType(arg.type)]));
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
      const objType = globalDefinitions.find(
        (def): def is ObjectTypeDefinitionNode =>
          def.kind === 'ObjectTypeDefinition' && def.name.value === returnTypeName
      );

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
