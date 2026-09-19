# Análisis de error — H0' (surface profile), spike `pnpm spike:profile --mode record`

Dataset v2, serializer `raw-diff`, 100 hunks, modelo `jev-1.13.0`. Reporte fuente: `reports/spike-profile-2026-09-19T10-16-05-895Z.json`. Predicciones crudas: `tests/fixtures/spike-profile/*.json` (10 archivos = 10 batches de 10 hunks). Ground truth: `datasets/profile-labels.jsonl` (reglas AST en `src/domain/ast-labels.ts`). Criterios enviados a Jev: `src/application/spike/question-sets/profile.ts`.

## Hallazgo transversal (antes de entrar pregunta por pregunta)

**Jev no está discriminando entre hunks dentro de un mismo batch.** El spike agrupa 10 hunks por request. Para las 5 preguntas medí el desvío estándar de las respuestas *dentro* de cada batch:

| Pregunta | Desvío estándar dentro de cada batch (10 batches) |
|---|---|
| `change_kind` (confidence) | batches con rango 0.58–0.99, pero **dentro** de cada batch el rango es de ~0.03–0.06 |
| `touches_public_api` | 0.005 – 0.026 |
| `touches_error_handling` | 0.004 – 0.020 |
| `touches_async` | 0.005 – 0.022 |
| `touches_io` | 0.004 – 0.023 |

Comparé hunks de archivos y naturaleza totalmente distintas dentro del mismo batch (ej. `vitest-d4fe198-1` en `cli-api.ts`, `vitest-e08c45c-1` en `jest-expect.ts`, `vitest-a6d5ea2-1` en `node.ts`): probabilidades casi idénticas en las 5 preguntas (`change_kind` add-behavior 0.69/0.72/0.69, `touches_public_api` 0.80/0.82/0.80, etc.), a pesar de que un hunk es un rename de método y otro es un reorder real de statements. La varianza real está *entre* batches, no *entre* hunks. Esto es consistente con `raw-diff`, que sí marca `+`/`-` por línea (verificado leyendo `hunk.diff` de varios hunks) — o sea, la información para diferenciar está disponible, Jev simplemente no la está usando por-hunk.

**Consecuencia metodológica:** cualquier ajuste de *threshold* (como hace el spike) puede mejorar F1 promedio, pero no arregla el problema real: el modelo no está leyendo cada hunk de forma independiente. Esto explica gran parte del FAIL mejor que cualquier ambigüedad de criterio.

**Otro dato duro:** en 100/100 hunks Jev eligió `add-behavior` para `change_kind` (0 veces cualquier otra clase). Probabilidad media por clase: `add-behavior` 0.865, `modify-behavior` 0.121, `rename-or-format` 0.010, `delete` 0.004 — dominante, no un near-tie. Y el campo `confidence` no coincide con `max(probabilities)` en 77/100 respuestas (dos señales de certeza inconsistentes entre sí, algo para reportar aparte, no forma parte de la evaluación de H0').

---

## 1. Criterio vs. regla de label, lado a lado

### `change_kind`

| | Texto exacto |
|---|---|
| Criterio (`profile.ts`) | `add-behavior`: "adds statements, branches, or calls not present before". `modify-behavior`: "changed... without adding/removing statements overall". `rename-or-format`: "same code: only names, whitespace, or comments differ". |
| Regla AST (`ast-labels.ts:85-99`) | Si la *firma estructural* (AST con identificadores normalizados, pero **literales de string/número preservados**) es igual → `rename-or-format`. Si no, compara conteo de `statements + CallExpression`: más en `after` → `add-behavior`; menos → `delete`; igual → `modify-behavior`. |

**Divergencia encontrada y verificada por código:** `structuralSignature()` (línea 48-62) sólo preserva el texto de `StringLiteral`/`NumericLiteral`. Un `RegularExpressionLiteral` cae al `else` genérico y sólo registra el *kind* del nodo (`"RegularExpressionLiteral"`), **sin el patrón**. Cualquier cambio de contenido dentro de una regex literal es invisible para la firma estructural. Confirmado ejecutando `classifyChangeKind()` contra `zod-f7fd554-1` (cambia por completo el regex de validación de `email`): devuelve `rename-or-format`, cuando en realidad es un cambio de comportamiento real (`modify-behavior`). **Esto es un bug de la regla AST**, no del criterio ni de Jev.

### `touches_public_api`

| | Texto exacto |
|---|---|
| Criterio | "changes the signature or exported shape of an exported function, class, interface, type, or variable" |
| Regla AST (`exportedSignatures`, línea 112-158) | Sólo procesa 5 tipos de *statement* top-level: `FunctionDeclaration`, `ClassDeclaration`, `InterfaceDeclaration`, `TypeAliasDeclaration`, `VariableStatement`. Compara `Map<name, signatureText>` entre before/after. |

**Tres divergencias verificadas contra código real, no hipotéticas:**

1. **No maneja `ExportDeclaration`** (`export { a, b } from "..."` o `export { a, b };`). Verificado: `zod-213ee75-1` agrega `INVALID` y `withParser` a un barrel re-export — cambio de superficie pública inequívoco — pero el AST parsea el statement como `ExportDeclaration`, que `exportedSignatures()` ignora por completo. `touchesPublicApi()` devuelve `false`. Bug confirmado corriendo la función contra el hunk real.
2. **Colisión de nombres en declaration merging.** El `Map` se indexa sólo por nombre, sin distinguir tipo de declaración. Zod usa el patrón idiomático `interface Foo {}` + `const Foo = ...` (mismo nombre). Verificado con `zod-56222cd-1`: el hunk cambia la firma de un método dentro de `interface ZodInstanceOf`, pero el `export const ZodInstanceOf = ...` (sin cambios, ubicado después en el statement order) pisa la entrada del `Map` con el mismo texto en before y after, ocultando el cambio real. `touchesPublicApi()` devuelve `false` cuando debería ser `true`.
3. **Campos `#privados` no se excluyen.** El filtro de miembros de clase es `!hasModifier(m, PrivateKeyword)`, que sólo detecta el modificador `private` de TS, no la sintaxis `#campo` de JS. Verificado con `hono-4b44abe-1`: cambia el inicializador de `#children` (campo verdaderamente privado) dentro de una clase exportada; el texto del miembro entra al `Map` como si fuera público. Label dice `true`; una lectura razonable del criterio dice `false` (no es superficie pública).

### `touches_error_handling`

| | Texto exacto |
|---|---|
| Criterio | "add or change a try, catch, finally, or throw, or call something whose name ends in 'Error'" |
| Regla AST (línea 166-188) | `hasErrorHandlingSurface(before) OR hasErrorHandlingSurface(after)` — detecta `try`/`throw`/`catch` en cualquier posición, o llamada/`new` cuyo *callee name* matchea `/Error/i` (case-insensitive, **substring, no "ends with"**). |

**Dos divergencias verificadas:**

1. **Semántica "presente" vs. "agregado/cambiado".** La regla evalúa el fragmento `before` completo Y el `after` completo, no el diff. Un `try`/`catch`/`throw` que ya existía sin tocarse (líneas de contexto del hunk) marca `true` aunque el criterio explícito diga "add or change". Verificado con `vitest-bac009d-1` y `vitest-d4fe198-1`: el `catch { }` / `try {` están en contexto sin tocar; el cambio real es un rename de método o de un comentario JSDoc. Nota: `raw-diff` sí marca `+`/`-` por línea, así que Jev *tiene* la info para distinguir contexto de cambio real — el problema de "presente vs. cambiado" es de la regla de label, no de lo que Jev recibe.
2. **Regex `/Error/i` demasiado amplia.** El criterio dice "ends in 'Error'"; la regla implementa "contains 'Error'" case-insensitive. `console.error(...)` → `calleeName` = `"error"` → matchea. Verificado con `trpc-60c89fc-1`: el único disparador es un `console.error(...)` sin tocar en el contexto, no manejo de errores real. Label dice `true` (falso positivo del label), Jev dio 0.15 (correcto).

### `touches_async` / `touches_io`

Mismo patrón que `touches_error_handling`: ambas usan `hasXSurface(before) || hasXSurface(after)` (línea 218-220 y 249-251), heredando el mismo problema de "presente en contexto" vs. "tocado por el diff". `IO_IDENTIFIER_NAMES` es una lista cerrada de 13 nombres (`fs`, `net`, `process`, `fetch`, `http`, `https`, `stream`, `Request`, `Response`, `readFile`, `writeFile`, `readFileSync`, `writeFileSync`) — no captura IO semántico sin ese nombre literal exacto (ej. utilidades de paths). Esto es fiel al criterio ("references things like fs, net, ... "), así que no es un bug, pero sí una fuente de casos límite razonables en ambas direcciones.

---

## 2. `change_kind`: distribución y muestra de 8 hunks

Distribución de probabilidad media por clase (100 hunks): `add-behavior` 0.865, `modify-behavior` 0.121, `rename-or-format` 0.010, `delete` 0.004. **Dominante, no near-tie.** Elección real: 100/100 `add-behavior`.

| hunk_id | AST | Jev (conf) | Lectura del criterio (a) | Lectura de reviewer (b) | Veredicto |
|---|---|---|---|---|---|
| `zod-a87ac36-1` | modify-behavior | add-behavior (0.68) | modify (sólo tipos/generics, 0 statements nuevos) | modify | **Jev mal** |
| `zod-f7fd554-1` | rename-or-format *(bug AST)* | add-behavior (0.63) | modify (regex distinto = valor distinto) | modify | **AST mal (bug regex) y Jev mal** |
| `vitest-d4fe198-1` | rename-or-format | add-behavior (0.59) | rename (rename de método, nada más) | rename | **Jev mal** |
| `vitest-e08c45c-1` | modify-behavior | add-behavior (0.63) | modify (mismos statements, re-scoped dentro de un if) | modify | **Jev mal** |
| `hono-8a0b18f-1` | modify-behavior | add-behavior (0.89) | ambiguo: ternario nuevo, ¿es "branch" nuevo? | modify (mismo statement, valor distinto) | **Ambiguo, criterio impreciso sobre "branch"** |
| `hono-6f101a7-1` | rename-or-format | add-behavior (0.88) | rename (sólo comentario JSDoc) | rename | **Jev mal, alta confianza injustificada** |
| `trpc-f8f0c0e-1` | rename-or-format | add-behavior (0.88) | rename (typo fix en comentario) | rename | **Jev mal, alta confianza injustificada** |
| `zod-51caf01-1` | rename-or-format | add-behavior (0.91) | rename (rename de función llamada, misma forma) | rename | **Jev mal** |

**Proporción:** 6/8 Jev claramente mal bajo ambas lecturas; 1/8 bug real de la regla AST (regex literal); 1/8 ambigüedad genuina de criterio ("branch" sin definir si incluye ternarios). El patrón dominante es Jev fallando incluso en casos triviales (comentario-only, typo fix) con confianza alta (0.88).

---

## 3. Nouls: 6 FP + 4 FN por pregunta

Umbral usado para clasificar: umbral óptimo por F1 reportado por el spike (`touches_public_api` 0.85, `touches_error_handling` 0.20, `touches_async` 0.80, `touches_io` 0.85).

### `touches_public_api`

| hunk_id | Jev | AST | Veredicto | Razón |
|---|---|---|---|---|
| `zod-741981f-1` FP | 0.92 | false | AST correcto | Refactor interno (`emitOwnKeys`), sin `export` en el hunk |
| `zod-213ee75-1` FP | 0.91 | false | **Jev correcto, AST mal (bug #1)** | Agrega nombres a un barrel re-export |
| `zod-764ac59-1` FP | 0.91 | false | AST correcto | Cambia sólo el cuerpo de una función no exportada |
| `zod-7b612b5-1` FP | 0.90 | false | AST correcto | Cuerpo interno; el `export` de la función contenedora está fuera del hunk |
| `zod-3a49696-1` FP | 0.90 | false | AST correcto | Nueva variable local + condición, sin firma exportada tocada |
| `zod-56222cd-1` FP | 0.90 | false | **Jev correcto, AST mal (bug #2)** | Cambia constraint genérico de un método de `interface ZodInstanceOf` exportada; el label lo oculta por colisión de nombre con el `const` |
| `hono-4b44abe-1` FN | 0.72 | true | **AST mal (bug #3)** | Sólo cambia el inicializador de un campo `#privado` |
| `vitest-455466c-1` FN | 0.79 | true | Jev subestima (dirección correcta) | Agrega `export type`/`export interface` nuevos |
| `vitest-6a99eac-1` FN | 0.86 | true | Correcto (falso negativo del sweep, no de Jev) | ≥ threshold real, se cuela por el punto de corte |
| `trpc-fb9fe87-1` FN | 0.87 | true | Correcto (idem) | ≥ threshold real |

Mezcla real: de los 6 FP, 4 son Jev sobre-disparando sobre código interno sin ningún `export` visible (probablemente por batch-anchoring); 2 son bugs confirmados de la regla AST. De los 4 FN, 2 son artefacto del punto de corte (Jev ya estaba del lado correcto con prob. alta) y 1 es otro bug de la regla AST (campo privado).

### `touches_error_handling`

| hunk_id | Jev | AST | Veredicto | Razón |
|---|---|---|---|---|
| `hono-75b8a49-1` FP | 0.96 | false | Jev mal | Sólo agrega un ítem a un array *dentro de un comentario JSDoc* |
| `hono-8a0b18f-1` FP | 0.95 | false | Jev mal | Ternario nuevo, cero relación con manejo de errores |
| `hono-5d911d2-1` FP | 0.95 | false | Jev mal | Union type de literales de string (headers HTTP) |
| `hono-30277ae-1` FP | 0.95 | false | Jev mal | Línea `@param` nueva en JSDoc |
| `hono-3bc96ba-1` FP | 0.95 | false | Jev mal | Imports y consts nuevos, sin try/catch/throw |
| `hono-2159deb-1` FP | 0.95 | false | Jev mal | Agrega una condición booleana a un ternario |
| `trpc-60c89fc-1` FN | 0.15 | true | **Jev correcto, AST mal (regex `/Error/i`)** | Único disparador es `console.error(...)` sin tocar |
| `vitest-bac009d-1` FN | 0.62 | true | **AST discutible (contexto sin tocar)** | `catch {}` sin tocar es contexto, no diff |
| `vitest-d4fe198-1` FN | 0.64 | true | **AST discutible (contexto sin tocar)** | `try {` sin tocar es contexto |
| `vitest-e08c45c-1` FN | 0.68 | true | Defendible como `true` | El `throw new AssertionError(...)` cambia de scope (antes incondicional, ahora dentro del `if`) |

Veredicto: **6/6 FP son Jev mal, con confianza casi idéntica (0.95-0.96) sin relación con el contenido real** — la evidencia más fuerte de batch-anchoring en toda la muestra. De los 4 FN, 1 es bug de label (regex), 2 son la ambigüedad "contexto vs. diff" de la regla, 1 es defendible como verdadero positivo real.

### `touches_async`

| hunk_id | Jev | AST | Veredicto | Razón |
|---|---|---|---|---|
| `hono-8a0b18f-1` FP | 0.92 | false | Jev mal | Ternario, sin async/await/Promise |
| `hono-3bc96ba-1` FP | 0.92 | false | Jev mal | Imports/consts, sin async |
| `hono-6f101a7-1` FP | 0.92 | false | Jev mal | Comentario JSDoc puro |
| `hono-5d911d2-1` FP | 0.91 | false | Jev mal | Union type de strings |
| `hono-2159deb-1` FP | 0.91 | false | Jev mal | Condición booleana nueva |
| `trpc-d1a9ec6-1` FP | 0.91 | false | Jev mal (pattern-matching por nombre) | Import de `raceAbortSignals`; el hunk sólo muestra el import, sin código async literal |
| `zod-62e6624-1` FN | 0.75 | true | Jev subestima (dirección correcta) | Agrega `validateAsync(...): Promise<boolean>` |
| `zod-bec73be-1` FN | 0.75 | true | AST discutible (contexto) | `Promise<...>` sólo en un type alias sin tocar, al final del hunk |
| `vitest-6108b81-1` FN | 0.76 | true | AST discutible (contexto) | `await` sin tocar en contexto |
| `vitest-7361465-1` FN | 0.77 | true | **Jev mal, miss real** | El diff agrega `private async writeMetadata()` con `await writeFile(...)` — tokens literales nuevos, no ambigüedad |

Veredicto: 5/6 FP son Jev mal con confianza uniforme (~0.91-0.92) sin relación al contenido; 1/6 es pattern-matching semántico razonable pero técnicamente fuera del criterio literal. De los FN, 2 son ambigüedad de contexto, 1 es Jev subestimando un caso claro, y 1 es un miss genuino (tokens `async`/`await`/`Promise` nuevos e ignorados).

### `touches_io`

| hunk_id | Jev | AST | Veredicto | Razón |
|---|---|---|---|---|
| `vitest-17e2b22-1` FP | 0.91 | false | Jev mal | Lógica de regex/string matching, sin IO |
| `vitest-91ab158-1` FP | 0.90 | false | Jev mal | `Set` de nombres de entornos, config pura |
| `vitest-972e24b-1` FP | 0.90 | false | Jev mal | Reorder de `if/else if`, sin IO |
| `vitest-b426c19-1` FP | 0.90 | false | Jev mal (semántico, sin nombre literal) | Manipulación de paths sin `fs`/`net`/etc. literal |
| `vitest-51e9494-1` FP | 0.90 | false | Jev mal | Comentario JSDoc puro (`@default`) |
| `vitest-6a99eac-1` FP | 0.89 | false | Jev mal | Sólo remueve `export` de dos const |
| `vitest-5f6a5e8-1` FN | 0.50 | true | AST discutible (contexto) | `import ... from 'node:fs'` sin tocar, en contexto |
| `trpc-3e0e979-1` FN | 0.63 | true | AST discutible (contexto) | `import * as fs` sin tocar; el diff real es un comentario |
| `hono-80959d4-1` FN | 0.79 | true | Razonable, cerca del threshold | Firma con `Request` en contexto, lógica de body cache nueva |
| `trpc-bdf2c65-1` FN | 0.85 | true | Correcto | El diff agrega `import * as fs from 'node:fs'` directamente |

Veredicto: 5/6 FP son Jev mal con confianza uniforme (~0.89-0.91), 1/6 es generalización semántica razonable fuera del criterio literal. 2/4 FN son ambigüedad de contexto, 2/4 son aceptables/correctos.

---

## 4. Conclusión por pregunta

| Pregunta | Label mal (bug) | Criterio ambiguo | Jev mal (real) | Proporción aprox. (sobre la muestra) |
|---|---|---|---|---|
| `change_kind` | 12% (regex literal) | 12% (¿qué es un "branch"?) | ~75% | Dominante: Jev, sesgo duro a "add-behavior" |
| `touches_public_api` | ~35% (3 bugs distintos: `ExportDeclaration`, colisión de nombres, `#privado`) | 0% | ~65% | Mixto real, label necesita arreglo antes de re-medir |
| `touches_error_handling` | ~15% (regex `/Error/i`) | ~30% (contexto vs. diff) | ~60% (FP uniformes) | Mixto, pero el patrón de FP (0.95 parejo) es puramente Jev |
| `touches_async` | 0% | ~30% (contexto vs. diff) | ~70% | Dominante: Jev |
| `touches_io` | 0% | ~30% (contexto vs. diff) | ~65% | Dominante: Jev |

**Propuestas concretas:**

1. **`change_kind`:** arreglar `structuralSignature()` para preservar el texto de `RegularExpressionLiteral` igual que hace con `StringLiteral`/`NumericLiteral` (una línea: agregar `ts.isRegularExpressionLiteral(node)` al branch que conserva `node.text`). Aclarar en el criterio si un ternario nuevo dentro de un `return` existente cuenta como "branch" para `add-behavior` o como "value changed" para `modify-behavior` — sugiero explicitarlo: *"a new conditional (`? :`) inside an existing statement is modify-behavior, not add-behavior; add-behavior requires a brand-new statement"*.

2. **`touches_public_api`:** (a) agregar manejo de `ts.isExportDeclaration` en `exportedSignatures()` para capturar `export { ... } from ...`; (b) indexar el `Map` por `(kind, name)` en vez de sólo `name`, para no perder declaraciones merged; (c) excluir miembros con nombre que empieza con `#` (o usar `ts.isPrivateIdentifier(member.name)`) del texto de firma de clase. Ningún cambio de criterio es necesario, el texto ya es preciso.

3. **`touches_error_handling` / `touches_async` / `touches_io`:** (a) cambiar la regla de `hasXSurface(before) || hasXSurface(after)` a **sólo evaluar las líneas marcadas `+`/`-` del diff** (no el fragmento completo before/after) — esto alinea la regla con el criterio tal como está escrito ("add or change") y con lo que Jev efectivamente puede ver (`raw-diff` ya trae el `+`/`-`). Esto probablemente resuelve ~30% de los FN de estas tres preguntas de un saque. (b) Para `touches_error_handling`: acotar la regex a *ends with* "Error" con mayúscula inicial (`/Error$/`) en vez de `/Error/i` en cualquier posición, para no capturar `console.error`/`logger.error`.

4. **El hallazgo transversal (batch-anchoring) es el más importante de arreglar antes de re-medir cualquier cosa.** Si Jev no está usando el contenido del hunk individual dentro de un batch de 10, ningún ajuste de criterio o de label va a mover la aguja de forma significativa. Recomiendo correr un spike de control: mismos 100 hunks, un hunk por request (batch size = 1), y comparar la varianza de las respuestas contra este run. Si la varianza sube y las respuestas se alejan de "casi siempre true / casi siempre add-behavior", confirma que el problema es de agregación de contexto en el prompt del batch, no del modelo per se.

---

## 5. Otras observaciones

- **`raw-diff` sí incluye marcado `+`/`-` por línea** (verificado leyendo `hunk.diff` directamente); no es un diff "antes/después" plano. Esto descarta que la ambigüedad contexto-vs-diff sea un problema de información disponible para Jev — es un problema de la regla de label (que trabaja sobre `before`/`after` completos, no sobre el diff) y, en los FP, de que Jev no usa esa información de todas formas.
- **El "export por fuera del hunk" sí ocurre** (`zod-7b612b5-1`): el hunk arranca a mitad de una función y no se puede saber, sólo con ese hunk, si la función contenedora es exportada. La regla AST maneja esto correctamente (no encuentra ningún `export` en el fragmento, dice `false`), pero es una limitación real del dataset/serializer que vale la pena documentar: ningún serializer actual (`raw-diff`, `before-after-json`, `json-with-context`) incluye la línea de declaración de la función contenedora cuando el hunk no la incluye.
- **`confidence` de `change_kind` no coincide con `max(probabilities)` en 77/100 casos.** Son dos señales de certeza separadas y a veces contradictorias (ej. probabilities favorece `add-behavior` 0.69 pero `confidence` reporta 0.59). No es parte de la evaluación de H0' pero es una inconsistencia del serializer de respuesta de Jev que vale la pena que alguien mire aparte.
- **Declaration merging (`interface X {}` + `const X = ...`)** es un patrón idiomático en Zod (y común en TS en general) que rompe cualquier regla AST indexada sólo por nombre de identificador — no es exclusivo de `touches_public_api`, vale la pena revisar si `classifyChangeKind` u otras reglas futuras tienen el mismo punto ciego.
