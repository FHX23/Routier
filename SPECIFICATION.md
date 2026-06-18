# DOCUMENTO DE ESPECIFICACIÓN, ARQUITECTURA Y HOJA DE RUTA: ROUTIER CLI

## 1. Visión General del Proyecto

Routier es una herramienta de interfaz de línea de comandos (CLI) diseñada para automatizar por completo el mapeo de arquitecturas de software backend y de routing. Su objetivo principal es actuar como un puente de sincronización sin fricción entre el código fuente de un proyecto y las aplicaciones de desarrollo y testing de APIs más populares del mercado, específicamente Postman e Insomnia (expandible a Bruno, Hoppscotch, entre otros).

El enfoque estratégico del proyecto sigue la filosofía de desarrollo ágil "de lo hiper-específico a lo general". En lugar de intentar construir una herramienta universal desde el primer día que maneje docenas de frameworks de manera mediocre, el desarrollo se ha segmentado para dominar un stack inicial crítico: Next.js combinado con endpoints REST y GraphQL. A partir de este núcleo robusto, el sistema se expandirá modularmente mediante adaptadores independientes hacia Express, NestJS, Fastify y otras tecnologías de servidor.

## 2. Estado Actual del Desarrollo (Lo que ya tenemos)

Hasta el momento, hemos establecido los cimientos estructurales del CLI bajo estándares modernos de desarrollo de Node.js y hemos implementado con éxito la lógica preventiva contra el caos en la organización de archivos de los usuarios.

### Componentes y Configuración Base Instalada:

**Gestor de Paquetes Eficiente (pnpm):** Configurado nativamente bajo la versión estricta de pnpm para evitar dependencias fantasma y acelerar la resolución de módulos mediante enlaces duros en el disco.

**Configuración del Compilador (tsconfig.json):** Configurado para compilar a ESM (ECMAScript Modules) nativo usando Target: ES2022 y resoluciones NodeNext. Se inyectaron explícitamente los tipos globales de Node (types: ["node"]) para resolver la interpretación estricta de variables de entorno como process.

**Orquestador del CLI (src/index.ts):** Motor interactivo inicial construido sobre commander para banderas de terminal y @clack/prompts para proveer una experiencia de usuario (UX) visualmente limpia, fluida y con barras de carga/espera en tiempo real.

**El Parser de Next.js (src/parsers/next/index.ts):**

Hemos programado un analizador estático que implementa soluciones automáticas a las tres estructuras más problemáticas y caóticas que un desarrollador de Next.js puede introducir en su proyecto:

- **Doble Sistema de Ruteo Simultáneo:** El script utiliza fast-glob de forma asíncrona para buscar, mapear e interpretar en una sola pasada tanto el App Router (/app//route.ts) como el Pages Router (/pages/api//*.ts), ignorando de forma segura carpetas de compilación o caché (node_modules, .next, dist).

- **Limpieza de Grupos de Rutas (Route Groups):** Implementamos filtros por expresiones regulares (\/\([^)]+\)/g) que detectan carpetas organizacionales con paréntesis —como app/(dashboard)/api/...— y eliminan el segmento invisible para Next.js, normalizando la URL final a /api/....

- **Conversión de Parámetros Dinámicos a Formato Estándar:** El CLI detecta la sintaxis de corchetes propia de Next.js para rutas dinámicas y catch-alls (ej. [id] o [[...slug]]) y los traduce automáticamente a la nomenclatura universal de rutas parametrizadas mediante dos puntos (:id, :slug), la cual es entendida directamente por los motores de importación de Postman e Insomnia.

- **Extracción de Métodos HTTP por Inspección de Código:** En lugar de asumir un comportamiento genérico, el CLI abre y lee el contenido de cada archivo route.ts en disco mediante node:fs/promises y aplica expresiones regulares dinámicas para verificar cuáles métodos (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS) están siendo exportados explícitamente por el desarrollador, mapeando con precisión quirúrgica las capacidades reales del endpoint.

## 3. Decisiones de Arquitectura Tomadas

Para asegurar que el proyecto pueda expandirse infinitamente sin requerir refactorizaciones masivas del núcleo, hemos diseñado una arquitectura basada en tuberías desacopladas (Pipelines Decoupled) dividida en cuatro capas independientes:

```
[Código de Usuario] ➔ [Parsers Específicos] ➔ [Formato Intermedio] ➔ [Generadores] ➔ [JSON de Salida]
```

### Capa de Entrada (Parsers)
Módulos aislados cuyo único trabajo es conocer las reglas de un framework en particular. El parser de Next.js no sabe qué es Postman; solo sabe cómo buscar archivos de Next.js. Si mañana añadimos Express, simplemente crearemos src/parsers/express/index.ts sin tocar una sola línea del parser de Next.js.

### Capa de Normalización (Intermediate Representation)
Un contrato de tipado de TypeScript estricto. Todos los parsers (Next, Express, Nest) deben transformar lo que encuentren a una interfaz unificada:

```typescript
interface Endpoint {
  path: string;
  methods: string[];
  fileType: 'rest' | 'graphql';
  sourceFile: string;
}
```

### Capa de Salida (Generators)
Módulos cuyo único trabajo es tomar los datos normalizados de la capa anterior y darles forma de archivo final.

### Decisión Estratégica de Formato de Salida
Tras evaluar el mito de que Postman e Insomnia comparten esquemas JSON idénticos (lo cual es falso), se determinó que el CLI generará una especificación OpenAPI 3.0 / 3.1 (Swagger) en formato JSON de manera primaria. Al exportar en OpenAPI, garantizamos compatibilidad nativa absoluta no solo con Postman e Insomnia, sino con cualquier herramienta moderna del ecosistema API (como Bruno, Hoppscotch o Paw). De forma secundaria, se podrán programar exportaciones nativas propietarias si fuera necesario.

## 4. Próximos Pasos (Hoja de Ruta Inmediata)

Cuando retomemos el proyecto, atacaremos secuencialmente los siguientes hitos técnicos:

### Fase 1: El Motor del Archivo de Configuración Local (routier.json)

**Objetivo:** Desarrollar un sistema de persistencia para evitar que el usuario deba responder preguntas de forma interactiva en cada ejecución (crucial para entornos de Integración Continua/CI-CD).

**Lógica:** Al correr `routier scan`, si el CLI no detecta un archivo routier.json en la raíz, lanzará el asistente interactivo de @clack/prompts preguntando cosas como: ¿Dónde está tu esquema de GraphQL?, ¿Cuál es tu directorio base?. Al finalizar, guardará las respuestas en un archivo de configuración local. En las ejecuciones siguientes, leerá ese JSON directamente para operar de manera 100% automática y silenciosa.

### Fase 2: El Gran Desafío de GraphQL (El Parser AST)

Como determinamos en el análisis inicial, un archivo de GraphQL en Next.js (generalmente ubicado en /api/graphql) es visto externamente como una única ruta POST vacía. Para extraer las Queries, Mutaciones y Tipos reales, tenemos que inspeccionar el backend por dentro.

**Paso 2.1:** Diseñar la lógica para localizar el archivo del Schema (ya sean archivos .graphql, .gql o código TypeScript que use Apollo Server / Yoga con plantillas gql).

**Paso 2.2:** Utilizar el parser oficial de la librería graphql para leer ese esquema y transformarlo en un AST (Abstract Syntax Tree).

**Paso 2.3:** Iterar sobre el AST para extraer los nombres de las operaciones disponibles, mapear sus argumentos de entrada y generar ejemplos de payloads válidos para inyectarlos en el JSON final.

### Fase 3: El Generador OpenAPI (src/generators/openapi.ts)

**Objetivo:** Tomar el array de endpoints normalizados (REST y GraphQL) y construir el gigantesco objeto JSON que cumpla estrictamente con la especificación OpenAPI 3.0.

**Lógica:** Mapear cada ruta al objeto paths de OpenAPI, asignar sus respectivos métodos HTTP, inicializar respuestas por defecto (como respuestas 200 OK simuladas) y estructurar el endpoint único de GraphQL documentando detalladamente las operaciones disponibles dentro de él.

### Fase 4: Exportación Física y Pruebas de Importación

**Objetivo:** Escribir el archivo final en el disco (ej. routier-openapi.json).

**Prueba de Fuego:** Tomar ese archivo generado por nuestro paquete e importarlo manualmente tanto en la interfaz de Postman como en la de Insomnia para validar que los endpoints, rutas dinámicas y métodos se configuren perfectamente a la primera y sin errores de formato.

## 5. Glosario Técnico de Referencia para el Proyecto

**AST (Abstract Syntax Tree):** Estructura de datos en forma de árbol que representa la estructura sintáctica del código fuente. Lo usaremos para leer código sin tener que ejecutarlo.

**ESM (ECMAScript Modules):** El estándar oficial moderno de JavaScript para manejar módulos utilizando las palabras clave import y export.

**Fast-Glob:** Una librería ultra veloz de Node.js especializada en recorrer directorios usando patrones de búsqueda avanzados (conocidos como expresiones glob).

**OpenAPI Specification:** Un formato de descripción de API estándar e independiente del lenguaje para REST APIs que permite a humanos y computadoras descubrir y comprender las capacidades del servicio.

---

**Estado Actual:** El sistema quedó en un punto de partida óptimo: el núcleo está limpio, la interfaz responde velozmente y el parser de Next.js ya tiene resuelta toda la lógica compleja de limpieza de rutas de archivos. El terreno está completamente preparado para abordar el desarrollo del archivo de configuración y el motor de GraphQL a nuestro regreso.
