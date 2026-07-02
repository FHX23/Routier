# Routier

**Routier** es una CLI que analiza proyectos **Next.js** (App Router y Pages Router), detecta endpoints REST y operaciones GraphQL, y genera colecciones importables en **Postman** e **Insomnia**.

![npm version](https://img.shields.io/npm/v/routier?style=flat-square)
![license](https://img.shields.io/badge/license-ISC-blue?style=flat-square)

## Instalación

```bash
npm install -g routier
```

o con pnpm:

```bash
pnpm add -g routier
```

## Uso Rápido

### Escanear un proyecto

```bash
routier scan --cwd /ruta/a/proyecto-next
```

Detecta y lista:
- ✅ Endpoints REST/HTTP (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`)
- ✅ Operaciones GraphQL (`Queries`, `Mutations`)
- ⚠️ Warnings si hay problemas de parseo

### Exportar a Postman e Insomnia

```bash
routier export --cwd /ruta/a/proyecto-next --format all --group-by type --sort alpha
```

Genera dentro del proyecto:
```
routier-exports/
  ├── routier-postman.json    # Colección Postman v2.1
  └── routier-insomnia.json   # Workspace Insomnia export format 4
```

Luego importa los archivos en:
- **Postman**: File → Import → Select file
- **Insomnia**: File → Import from file

## Ejemplos

### Scan básico
```bash
routier scan --cwd ./myapp
```

### Export con agrupación y orden
```bash
routier export \
  --cwd ./myapp \
  --format all \
  --group-by type \
  --sort alpha \
  --base-url http://localhost:3000
```

### Export solo Postman, salida plana
```bash
routier export \
  --cwd ./myapp \
  --format postman \
  --group-by none
```

### Con schema GraphQL externo
```bash
routier export \
  --cwd ./myapp \
  --graphql-schema ./schemas/api.graphql \
  --format all
```

## Opciones

| Opción | Descripción | Defecto |
|--------|-------------|---------|
| `--cwd <path>` | Ruta del proyecto a analizar | `.` |
| `--format <fmt>` | Formato: `all`, `postman`, `insomnia`, `openapi` | `all` |
| `--out <path>` | Carpeta de salida | `./routier-exports` |
| `--base-url <url>` | URL base para requests | `{{baseUrl}}` |
| `--group-by <mode>` | Agrupar por: `type`, `method`, `path`, `none` | `type` |
| `--sort <order>` | Orden: `alpha`, `none` | `alpha` |
| `--graphql-schema <path>` | Schema GraphQL externo (`.graphql` o `.gql`) | Auto-detecta |
| `--framework <fw>` | Framework: `next` | `next` |
| `--exclude <dirs...>` | Lista de carpetas o globs a ignorar en el escaneo | (Opciones por defecto) |

## Características

### 🎯 Detección automática
- **Next.js App Router**: Rutas en `app/**/route.ts`
- **Next.js Pages Router**: Rutas en `pages/api/**/*.ts`
- **GraphQL**: Schemas `.graphql`, `.gql` y `gql`/`typeDefs` estáticos en TypeScript

### 🧠 Inferencia Avanzada
- **Cabeceras y Auth**: Detecta de forma estática lecturas de cabeceras (ej. `req.headers.get('Authorization')`), inyectando tokens variables estándar (`Bearer {{token}}`) en OpenAPI, Postman e Insomnia.
- **Payloads y Zod**: Analiza recursivamente validadores Zod (`schema.parse(body)`) a nivel de declaración (`z.object({...})`) para generar ejemplos JSON ficticios realistas con emails, UUIDs, números, booleanos, enums y arrays en peticiones POST/PUT/PATCH.

### 📁 Normalización de rutas
- Rutas dinámicas Next.js (`[id]`, `[...slug]`) → formato de parámetro (`:id`, `:slug`)
- Route groups (`(admin)`) → invisibles en la ruta final

### 🎨 Agrupación visual
- **Por tipo**: `REST` y `GraphQL` como carpetas principales
- **Por método**: `GET`, `POST`, `PUT`, etc.
- **Por ruta**: Agrupación jerárquica de paths
- **Plana**: Sin agrupación, lista lineal

### 📊 Exportadores nativos
- **Postman Collection v2.1**: Importable directamente
- **Insomnia export format 4**: Con workspace y environment predefinido

- ✅ MVP: Next.js + GraphQL + Postman/Insomnia
- ✅ Configuración persistente e interactiva (`routier.json`)
- ✅ Generador OpenAPI consolidado (`routier-openapi.json`)
- ✅ Inferencia avanzada de Auth, cabeceras y bodies de Zod
- 🔮 Próximas versiones:
  - Soporte para Express, Fastify, NestJS
  - CI/CD integration

## Licencia

[ISC](./LICENSE)

## Contribuyendo

Las contribuciones son bienvenidas. Por favor:

1. Fork el repositorio
2. Crea una rama (`git checkout -b feature/amazing-feature`)
3. Commit tus cambios (`git commit -m 'Add amazing feature'`)
4. Push a la rama (`git push origin feature/amazing-feature`)
5. Abre un Pull Request

## Soporte

Para reportar bugs o solicitar features, abre un [issue en GitHub](https://github.com/FHX23/Routier/issues).

---

**Made with ❤️ by FHX23**
