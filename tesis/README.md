# tesis

Proyecto base en Node.js + TypeScript (ESM, TypeScript estricto).

## Requisitos

- Node.js >= 20

## Instalación

```bash
npm install
```

## Comandos

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Ejecuta `src/index.ts` con `tsx`, sin compilar. |
| `npm run build` | Compila TypeScript a `dist/`. |
| `npm start` | Ejecuta el build (`dist/index.js`). |
| `npm test` | Corre los tests con el runner nativo de Node. |
| `npm run typecheck` | Verifica tipos sin generar salida. |

## Estructura

```
src/
  index.ts        entrypoint
  config.ts       configuración leída del entorno
  lib/logger.ts   logger JSON con filtro por nivel
tests/            tests con node:test
```

## Configuración

Se lee de variables de entorno; todas son opcionales:

| Variable | Por defecto | Valores |
| --- | --- | --- |
| `APP_NAME` | `tesis` | texto libre |
| `NODE_ENV` | `development` | `development`, `test`, `production` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Un valor no reconocido cae al valor por defecto.
