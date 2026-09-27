# Routier

[![npm version](https://img.shields.io/npm/v/routier?style=flat-square)](https://www.npmjs.com/package/routier)
[![CI](https://img.shields.io/github/actions/workflow/status/FHX23/Routier/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/FHX23/Routier/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/routier?style=flat-square)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-ISC-blue?style=flat-square)](./LICENSE)

**Routier** analiza el código fuente de tu API y genera colecciones **OpenAPI 3**, **Postman** e **Insomnia** listas para importar, sin decoradores, anotaciones ni servidor corriendo.

Soporta **Next.js** (App Router y Pages Router), **Express**, **Fastify**, **NestJS** y schemas **GraphQL**. Además infiere la autenticación (tokens Bearer y sesiones por cookie), los parámetros de query y los bodies a partir de tus validaciones Zod, Joi, TypeBox y JSON Schema, de tus DTOs, de tus tipos TypeScript o simplemente de los campos que leen tus handlers.

[Read in English](./README.md)

```text
$ npx routier export --base-url http://localhost:3000

●  12 REST endpoints, 4 GraphQL operations
◆  Written routier-exports/routier-openapi.json
◆  Written routier-exports/routier-postman.json
◆  Written routier-exports/routier-insomnia.json
```

## Contenido

- [Instalación](#instalación)
- [Uso rápido](#uso-rápido)
- [Qué detecta Routier](#qué-detecta-routier)
- [Referencia de la CLI](#referencia-de-la-cli)
- [Archivo de configuración](#archivo-de-configuración)
- [Uso como librería](#uso-como-librería)
- [Limitaciones](#limitaciones)
- [Roadmap](#roadmap)
- [Contribuir](#contribuir)

## Instalación

Routier requiere **Node.js 22.12 o superior**.

```bash
# Ejecutarlo una vez sin instalar
npx routier scan

# O agregarlo al proyecto
npm install --save-dev routier
pnpm add -D routier

# O instalarlo globalmente
npm install -g routier
```

## Uso rápido

Desde la raíz de tu proyecto:

```bash
# 1. Ver qué encuentra Routier
routier scan

# 2. Generar las colecciones
routier export --base-url http://localhost:3000
```

Los archivos se escriben en `./routier-exports`, dentro del proyecto analizado:

| Archivo | Se importa en |
| --- | --- |
| `routier-openapi.json` | Swagger UI, Redoc, Bruno, Hoppscotch, Scalar, Postman, Insomnia… |
| `routier-postman.json` | Postman → **Import** → seleccionar el archivo |
| `routier-insomnia.json` | Insomnia → **Import** → seleccionar el archivo |

Las colecciones incluyen una variable `baseUrl`, una variable `token` para las requests que necesitan `Authorization: Bearer …` y una variable `session` para las sesiones por cookie (se envía como header `Cookie` con el nombre de cookie correcto). Así las completas una sola vez. Los query params opcionales vienen incluidos pero desactivados, listos para activarlos.

## Qué detecta Routier

El framework se detecta desde tu `package.json`. Usa `--framework` para forzar uno.

| | Rutas | Auth y cabeceras | Query params | Body |
| --- | --- | --- | --- | --- |
| **Next.js** | handlers `app/**/route.ts`, `pages/api/**` (métodos inferidos de `req.method`), route groups, segmentos dinámicos y catch-all, `export { handler as GET }`, `export const { GET, POST } = handlers` | sesiones de next-auth (`auth()`, `getServerSession`), better-auth, Clerk, Supabase y Lucia, también a través de funciones auxiliares y de `middleware.ts`/`proxy.ts`; `req.headers.get()`, `headers()` | `searchParams.get()`, `req.query` | `await req.json()` validado con Zod, tipado (`as T`, `: T`), desestructurado o pasado a server actions; `formData()` (multipart) y `text()` |
| **Express** | `app.get()`, `router.post()`, `router.route('/x').get().post()`, `app.use('/prefijo', router)` anidados entre archivos ESM y CommonJS, routers anónimos encadenados (`Router().use(...)`) y rutas montadas desde arrays | middlewares de auth (`requireAuth`, `passport.authenticate`, `auth.optional`…), `req.session`, `req.get()`, `req.header()` | `req.query`, también cuando se pasa a servicios | middlewares validadores con Zod o Joi (`validate({ body, query })`), uso de `req.body`, subidas con multer |
| **Fastify** | `fastify.get()`, `fastify.route({ method, url })`, `register(plugin, { prefix })`, plugins en línea, `@fastify/autoload` (incluidos los `autohooks`) | hooks `onRequest` / `preHandler`, `addHook` con funciones de auth o verificación de sesión | `schema.querystring`, `request.query` | `schema.body` con JSON Schema, TypeBox o Zod; subidas multipart |
| **NestJS** | `@Controller` + `@Get/@Post/…`, `setGlobalPrefix` (también desde valores por defecto de la configuración y con `exclude`), versionado por URI y `@Version` | `@UseGuards(AuthGuard)`, `@ApiBearerAuth`, exclusión con `@Public()`, `consumer.apply(AuthMiddleware).forRoutes(...)`, `@Headers('x')` | `@Query('x')`, `@Query() dto`, `@Query() query` seguido hasta los servicios | `@Body() dto` con DTOs de class-validator, `PartialType`/`PickType`/`OmitType`, `ZodValidationPipe`, subidas con `FileInterceptor` |
| **GraphQL** | archivos `.graphql` / `.gql` y templates estáticos `gql` / `typeDefs`, `extend type`, tipos raíz personalizados | — | — | variables generadas para escalares, enums e input objects |

El soporte de Zod cubre Zod 3 y 4 (incluidos imports con nombre como `import { object, string } from 'zod'`): objetos anidados, arrays, enums, literales, uniones, records, `z.email()`/`z.uuid()`/`z.url()`, `.optional()`, `.nullable()`, `.default()`, `.extend()`, `.pick()`, `.omit()`, `.partial()`, y schemas importados de otros archivos (rutas relativas y alias `@/`). También se interpretan Joi (`Joi.object().keys(...)`) y TypeBox (`Type.Object(...)`), y tipos TypeScript como `Partial<Omit<T, 'id'>>`, `z.infer<typeof schema>` y los enums de Prisma.

Los bodies de ejemplo respetan las validaciones que encuentra Routier (`min`/`max`, expresiones regulares, formatos, enums y valores por defecto), así que las requests generadas pasan la validación del servidor sin editarlas: por ejemplo, un patrón de RUT chileno produce `1.111.111-1` y `price: z.number().min(100)` produce `100`.

Ejemplo de lo que genera Routier a partir de un handler de Next.js:

```ts
// app/api/posts/[id]/route.ts
import { updatePostSchema } from '@/lib/schemas';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get('authorization');
  const data = updatePostSchema.parse(await req.json());
  // ...
}
```

```jsonc
// routier-openapi.json (extracto)
"/api/posts/{id}": {
  "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
  "patch": {
    "operationId": "patchApiPostsById",
    "tags": ["posts"],
    "security": [{ "bearerAuth": [] }],
    "requestBody": {
      "content": {
        "application/json": {
          "schema": { "type": "object", "properties": { "title": { "type": "string" }, "email": { "type": "string", "format": "email" } } },
          "example": { "title": "string", "email": "user@example.com" }
        }
      }
    }
  }
}
```

## Referencia de la CLI

### `routier scan`

Lista los endpoints y las operaciones GraphQL encontrados en un proyecto.

| Opción | Descripción | Por defecto |
| --- | --- | --- |
| `--cwd <ruta>` | Directorio del proyecto | `.` |
| `--framework <nombre>` | `auto`, `next`, `express`, `fastify` o `nestjs` | `auto` |
| `--graphql-schema <ruta>` | Archivo de schema GraphQL explícito | autodetectado |
| `--exclude <globs...>` | Patrones glob a ignorar | — |
| `--json` | Imprime el resultado como JSON (útil en scripts y CI) | — |
| `--no-interactive` | Nunca pregunta si crear `routier.json` | — |

### `routier export`

Genera los archivos de salida. Acepta todas las opciones de `scan` excepto `--json`, y además:

| Opción | Descripción | Por defecto |
| --- | --- | --- |
| `--format <formato>` | `all`, `openapi`, `postman` o `insomnia` | `all` |
| `--out <ruta>` | Carpeta de salida, relativa a `--cwd` | `./routier-exports` |
| `--base-url <url>` | URL base de las requests | variable `{{baseUrl}}` |
| `--group-by <modo>` | Carpetas de la colección: `type` (REST / GraphQL), `method`, `path` o `none` | `type` |
| `--sort <modo>` | `alpha` o `none` | `alpha` |

Ejemplos:

```bash
routier export --format openapi
routier export --framework express --cwd ./apps/api
routier export --format postman --group-by method --out ./collections
routier scan --json > routes.json
```

## Archivo de configuración

En vez de repetir flags, crea un `routier.json` en la raíz del proyecto. Todas las claves son opcionales y los flags de la CLI siempre tienen prioridad:

```json
{
  "framework": "auto",
  "out": "./routier-exports",
  "baseUrl": "http://localhost:3000",
  "format": "all",
  "groupBy": "type",
  "sort": "alpha",
  "graphqlSchema": "./schema.graphql",
  "exclude": ["**/mocks/**", "**/temp/**"]
}
```

Si ejecutas Routier en una terminal interactiva sin flags y sin `routier.json`, te ofrece crear el archivo. Usa `--no-interactive` (o ejecútalo en CI) para saltar la pregunta.

## Uso como librería

```ts
import { scanProject, generateOpenAPI, generatePostmanCollection } from 'routier';

const scan = await scanProject({ cwd: './mi-api', framework: 'auto' });
const openapi = generateOpenAPI(scan, { baseUrl: 'https://api.example.com', title: 'Mi API' });
const postman = generatePostmanCollection(openapi, { baseUrl: 'https://api.example.com', groupBy: 'method' });
```

También se exportan `scanNextRoutes`, `scanGraphQLSchema`, `parseOpenAPI`, `generateInsomniaExport`, `writeExports`, `loadConfig`, `detectFrameworks` y todos los tipos de TypeScript (`ScanResult`, `Endpoint`, `JsonSchema`, …).

## Limitaciones

Routier lee tu código de forma estática y nunca lo ejecuta, así que solo ve lo que está escrito de forma literal:

- Se omiten las rutas cuyo path se construye en runtime (`app.get(prefix + '/x')`, tablas de rutas cargadas de otros módulos o generadas dinámicamente). Los arrays literales recorridos con `forEach` sí se soportan.
- No se interpretan librerías de validación distintas de Zod, Joi, TypeBox, class-validator y JSON Schema (por ejemplo Yup o Valibot); en ese caso Routier usa los campos que lee tu handler.
- Las operaciones GraphQL se leen desde SDL. Los schemas code-first (`@Resolver` de NestJS, Pothos, TypeGraphQL…) solo se detectan si el archivo `.graphql` generado está en el repositorio.
- Los valores de ejemplo cumplen las validaciones declaradas, pero no son datos reales: los IDs de registros existentes, los valores únicos y las reglas `refine()` personalizadas todavía hay que completarlos a mano.

Si Routier no reconoce un patrón que usas, [abre un issue](https://github.com/FHX23/Routier/issues/new/choose) con un fragmento pequeño de código.

## Roadmap

- [x] Next.js App Router y Pages Router
- [x] Schemas GraphQL (SDL)
- [x] Exportadores OpenAPI 3, Postman e Insomnia
- [x] Configuración con `routier.json`
- [x] Inferencia de auth, cabeceras, query params y bodies Zod
- [x] Express, Fastify y NestJS
- [x] Schemas Joi y TypeBox, sesiones por cookie y bodies sin librerías de validación
- [ ] Schemas Yup y Valibot
- [ ] Schemas de respuesta
- [ ] GitHub Action que mantenga las colecciones actualizadas y reporte cambios de la API en los pull requests

## Contribuir

Las contribuciones son bienvenidas. Revisa [CONTRIBUTING.md](./CONTRIBUTING.md) para ver cómo preparar el entorno y las pautas del proyecto.

## Licencia

[ISC](./LICENSE) © Matias Arenas (FHX23)
