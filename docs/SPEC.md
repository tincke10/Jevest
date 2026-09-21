# Jevest — Revisión automatizada de PRs con Jev como capa de decisión

> Estado: DRAFT v0.3 — 2026-09-19
> v0.3 incorpora el resultado de la fase 0 (H0 FALLIDA con datos limpios) y el pivote: Jev nunca juzga si un hunk tiene un defecto; decide sobre superficie del código, sobre texto y sobre metadatos. Ver §4 y §13.
> v0.2 (2026-09-18) reemplazó a v0.1 (laboratorio genérico de harness) con un caso concreto con aporte a la comunidad.
> Fuentes: [LangChain — Building a harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev) + docs oficiales de TypeSafe AI (ver §14).

---

## 1. Qué es Jev y qué NO es

**Jev** es el primer modelo público de TypeSafe AI, de la clase "System One". No genera texto. Recibe un **state** (texto o JSON) y un mapa de **questions** tipadas, y devuelve **respuestas tipadas con probabilidades calibradas** en una sola llamada. Entrenado con RLCD (Reinforcement Learning for Calibrated Decisions).

| Dimensión | Jev | LLM tradicional |
|---|---|---|
| Output | Tipado: `choice` / `score` / `noul` + probabilidades | Texto libre |
| Latencia | 70–500 ms (claim del vendor) | segundos |
| Costo | $0.042 / MTok input, output gratis | $0.20–$10 / MTok input |
| Multi-pregunta | Todas en paralelo en 1 request | 1 llamada por decisión |
| Genera texto | NO | SÍ |
| Input | Solo texto y JSON | Depende |

### 1.1 Primitivas

| Tipo | Pregunta | Request | Response |
|---|---|---|---|
| `noul` | Proposición sí/no | `instructions`, `criteria?: {true, false}` | `noul: 0–1` (sin `confidence`) |
| `choice` | 1 de N opciones (N ≤ 255) | `instructions`, `criteria: {opción: descripción}` | `choice`, `probabilities`, `confidence` |
| `score` | Escala ordinal (≥ 2 niveles) | `instructions`, `criteria: [nivel...]` | `score`, `legend`, `probabilities`, `confidence` |

`confidence` se deriva de la distribución: concentrada = alta, dispersa = baja. Los umbrales los define el dominio; la doc recomienda tres bandas (automático / confirmar / escalar).

### 1.1.1 Notas del SDK real (`@typesafe-ai/sdk` v0.6.0, verificado contra los `.d.mts` instalados)

- Método: `client.systemOne({ state, questions, model? }, options?)`. El puerto de dominio `decide()` lo envuelve.
- `request_id` **no** viene en el resultado plano; hay que usar `.withResponse()` sobre la promesa. El adapter lo hace siempre.
- `usage` viene en snake_case; el adapter mapea a camelCase.
- `score` es un valor esperado continuo (por ejemplo `1.4`), no un índice entero de nivel.
- No hay clase de error para `529`; cae en `InternalServerError` (todo 5xx). Retry en 429 y 5xx; nunca en 401 ni 422.
- El cliente trae retry propio (`maxRetries` 2) y timeout de 10 s. El adapter maneja retry y timeout por su cuenta, así que se construye el cliente con `retry: { maxRetries: 0 }` y se pasa `timeout` por llamada.

### 1.2 Debilidades documentadas (Jev 1.13)

Cada una se traduce en un requerimiento en §8.

- Interpretación literal; falla con indirección y dobles negaciones.
- No cuenta, no calcula, no compara números ni fechas.
- Contexto irrelevante degrada la precisión.
- **No trata el input como hostil**: vulnerable a instrucciones inyectadas en el state.
- Inglés primero; otros idiomas con menor precisión.
- Ventana de contexto acotada, límite no publicado.
- **Sin benchmark público sobre código.** La doc habla de texto y estado estructurado. Esto es la incógnita central del proyecto.

---

## 2. El problema que atacamos

Los bots de revisión de PRs basados en LLM tienen tres dolores que hacen que la gente los apague:

1. **Ruido**: comentan de más. Estilo mezclado con defectos reales, sin señal de cuál importa.
2. **Costo indiscriminado**: revisan con el mismo esfuerzo un bump de dependencia que un cambio en auth.
3. **Verificación cara**: filtrar hallazgos falsos requiere OTRA pasada de LLM por hallazgo.

**Jev no reemplaza al revisor.** El LLM sigue escribiendo la revisión. Jev decide, en milisegundos y con confianza calibrada, **qué revisar, cuánto revisar y qué publicar**.

Analogía: el LLM es el inspector senior que escribe el informe. Jev es el portero que en 200 ms decide si el inspector tiene que subir a la obra, a qué piso, y cuáles de sus observaciones van al acta y cuáles a la papelera.

---

## 3. Pipeline propuesto

```
PR abierto / actualizado
        │
        ▼
┌──────────────────┐   1 request Jev, N preguntas
│ 1. Triage        │──▶ categoría · riesgo · necesita_humano · idioma
└──────────────────┘
        │ riesgo bajo + confianza alta → SKIP review LLM (solo etiqueta)
        ▼
┌──────────────────┐   1 request Jev, M preguntas × hunk (fan-out)
│ 2. Hunk profile  │──▶ por hunk: tipo_de_cambio · toca_api_publica · toca_zona_sensible
└──────────────────┘   (superficie, nunca "¿tiene un bug?")
        │ hunks de solo formato/renombre → omitidos; el resto va al LLM CON su perfil
        ▼
┌──────────────────┐   LLM (pluggable)
│ 3. Review LLM    │──▶ findings estructurados [{file, line, claim, rationale}]
└──────────────────┘
        │
        ▼
┌──────────────────┐   1 request Jev, M preguntas × finding (fan-out)
│ 4. Finding filter│──▶ por finding: es_defecto_real · severidad · accionable
└──────────────────┘
        │ alta confianza → publicar · media → cola humana · baja → descartar
        ▼
┌──────────────────┐   1 request Jev
│ 5. Merge gate    │──▶ seguro_para_automerge (noul) + banda de confianza
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ 6. Publish       │──▶ comentarios inline · resumen · label · check status
└──────────────────┘
```

Cada etapa registra `request_id`, tokens, latencia y decisión para el benchmark.

---

## 4. Objetivo e hipótesis

El entregable es **evidencia más una GitHub Action instalable**. Sin evidencia, es una demo más.

### 4.1 Resultado de la fase 0 (cerrada el 2026-09-19)

**H0 original**: "Jev clasifica si un hunk tiene un defecto con recall ≥ 0.85 y F1 ≥ 0.75". **FALLIDA** en dos corridas contra `jev-latest`, la segunda sobre el dataset v2 (solo código fuente, sin confound de rutas). Evidencia en `reports/spike-2026-09-19T07-27-41-337Z.md` y fixtures grabados en `tests/fixtures/spike/`.

| Formato | Precision | Recall | F1 | Confianza mediana |
|---|---|---|---|---|
| raw-diff | 0.837 | 0.720 | 0.774 | 0.000 |
| before-after-json | 0.717 | 0.660 | 0.688 | 0.150 |
| json-with-context | 0.760 | 0.760 | 0.760 | 0.130 |

Lectura: hay señal débil (precisión 0.84 en diff crudo), pero el recall no alcanza y, sobre todo, **Jev reporta confianza casi nula**. Juzgar un defecto exige razonar sobre inputs e indirecciones: es una tarea de sistema 2, y la calibración de Jev lo dice con honestidad. La pregunta estaba mal hecha. Esto es un resultado negativo publicable (fase 3).

### 4.2 Hipótesis vigentes (v0.3)

Principio del pivote: **Jev responde preguntas de reconocimiento, nunca de razonamiento**. Sobre código: qué toca el hunk (superficie). Sobre texto: qué dice un finding, un título, una descripción. Sobre metadatos: tamaño, rutas, labels, CI.

| ID | Hipótesis | Métrica | Criterio de éxito | Fase |
|---|---|---|---|---|
| **H1** | El filtro de findings recorta ruido del LLM sin perder defectos reales | Sobre findings del LLM en los 100 hunks v2: un finding es *real* si el hunk es defecto y el finding señala las líneas que el fix tocó; el resto es *ruido*. Recall de reales tras el filtro; % de ruido descartado | Recall ≥ 0.95; ≥ 40% del ruido descartado. **Hipótesis central: si falla, Jev no aporta al review** | 1a |
| H6 | El filtro con Jev es más barato que con un LLM juez | Costo y latencia de la etapa 4 con Jev vs. con LLM juez sobre el mismo set | ≥ 100x más barato, recall equivalente | 1a |
| H3 | La confidence está calibrada sobre findings | ECE sobre ≥ 200 findings etiquetados | ECE < 0.1 | 1a |
| **H0'** | Jev perfila un hunk por superficie con precisión útil | `change_kind` (choice: add-behavior / modify-behavior / delete / rename-or-format), `touches_public_api` (noul), `touches_error_handling` (noul), `touches_async` (noul), `touches_io` (noul). Ground truth derivada por AST y diff en código, verificada a mano en muestra | Accuracy ≥ 0.90 en `change_kind`; F1 ≥ 0.85 en cada noul; confianza mediana ≥ 0.5 | 0b |
| H2 | Triage + perfil de hunks reducen costo del LLM | Tokens LLM por PR con y sin Jev | −30% tokens con misma tasa de detección (rebajado: ya no se omiten hunks por defecto) | 1b |
| H4 | Latencia total de Jev por PR es despreciable | Suma de latencias Jev p95 por PR | p95 < 2 s para PRs de ≤ 50 hunks | 1b |
| H5 | El pipeline resiste PRs adversariales | Suite de PRs con instrucciones inyectadas | 0 auto-merges indebidos; 0 findings críticos suprimidos | 1b |
| **H7** | Jev detecta cuándo la descripción de una PR no coincide con el cambio real (coherencia intención–cambio), con un state de tres capas: intención del autor (título/cuerpo, no confiable), hechos del cambio calculados en código a partir de rutas y conteos (universal al lenguaje) y un resumen del diff escrito por un LLM que nunca ve la descripción | Dataset `datasets/prs.jsonl` (100 PRs OSS mergeadas con descripción ≥ 200 chars) y `datasets/coherence-pairs.jsonl` (100 pares coherentes + 100 pares con descripción cruzada de otra PR del mismo repo; ground truth exacta sin etiquetado manual). Pregunta primaria `matches_intent` (noul). Dos variantes: **con** resumen LLM y **sin** resumen (control: solo intención + hechos de ruta) | Sobre pares incoherentes: recall ≥ 0.90 con precisión ≥ 0.85 al mejor umbral; ECE < 0.1; confianza mediana ≥ 0.5. Se juzga cada variante por separado: si la variante **sin** resumen ya cumple, el resumen LLM no se incorpora al pipeline. Un pase con recall < 0.75 en ambas variantes cierra H7 como FAIL | 0c |

Regla de corte: **H1 es bloqueante para la fase 1b**. H7 no bloquea nada: decide si el triage (etapa 1) recibe un state de producto en lugar de metadatos planos. H0' no bloquea: si falla, la etapa 2 se reduce a metadatos de ruta y el LLM recibe todos los hunks.

### 4.3 Resultado de la fase 0b (2026-09-19): H0' PARCIAL

Tres corridas sobre el dataset v2 con `raw-diff`. La primera, con lotes de 10 hunks por request, dio `change_kind` 0.48 con Jev respondiendo lo mismo para todos los hunks del lote: **anclaje por lote**, causa raíz documentada en `docs/analysis/h0-prime-error-analysis.md` y convertida en NFR-14. Las dos siguientes, con un hunk por request (la segunda es un replay con las etiquetas AST corregidas, costo cero):

| Pregunta | Lote 10 | Lote 1, etiquetas v1 | Lote 1, etiquetas v2 | Umbral | Veredicto |
|---|---|---|---|---|---|
| `change_kind` (accuracy) | 0.480 | 0.720 | **0.800** (conf. mediana 0.965) | 0.90 | Cerca; la clase `modify-behavior` (F1 0.69) concentra el error |
| `touches_error_handling` (F1) | 0.310 | 0.774 | **0.889** (ECE 0.087) | 0.85 | **PASS** |
| `touches_async` (F1) | 0.431 | 0.914 | **0.846** (ECE 0.110) | 0.85 | Al límite; solo 11 positivos |
| `touches_io` (F1) | 0.377 | 0.815 | 0.714 (ECE 0.169) | 0.85 | Insuficiente; solo 6 positivos, un error mueve 0.2 |
| `touches_public_api` (F1) | 0.314 | 0.581 | 0.645 (recall 1.0, precisión 0.48) | 0.85 | Brecha de definición: el `export` suele quedar fuera del hunk y Jev lee "toca API pública" como "modifica el cuerpo de algo exportado" |

Lectura: con un ítem por request, Jev **sí** perfila superficie con confianza alta y calibración razonable. Lo que queda por debajo del umbral es, en parte, soporte estadístico pobre (5–11 positivos sobre 100) y, en parte, definición.

Decisión provisional para FR-3 (a confirmar en fase 1b):
- Jev responde `change_kind`, `touches_error_handling` y `touches_async`.
- `touches_public_api` se deriva **en código** por AST sobre el archivo completo, donde el `export` es visible. No se le pregunta a Jev.
- `touches_io` queda fuera hasta tener ≥ 30 positivos etiquetados.
- Pendiente: dataset de ≥ 300 hunks para que los nouls raros tengan soporte, y verificación manual de `modify-behavior` vs `add-behavior`.

---

## 5. Fases y alcance

### Fase 0 — Spike de defectos (CERRADA, H0 fallida)
- Runner `pnpm spike` con tres serializadores, fan-out, reporte por hunk y fixtures grabados. Se conserva como herramienta y como evidencia.
- Dataset v2: 100 hunks de código fuente (50 defecto / 50 benigno) de zod, vitest, hono y trpc.

### Fase 1a — Spike del filtro de findings (bloqueante para 1b)
1. `ReviewerPort` con adapters Anthropic y OpenAI, salida estructurada `{file, line_start, line_end, claim, rationale, suggested_severity}`.
2. Generar findings sobre los 100 hunks v2 con un revisor LLM. Etiquetado automático: *real* si el hunk es defecto y el rango de líneas del finding se solapa con las líneas que el fix cambió; *ruido* en cualquier otro caso. Verificación manual de una muestra de 40.
3. Runner del filtro: por finding, en fan-out, `is_real_defect` (noul), `severity` (score), `is_style_only` (noul), `actionable` (noul). Estado por finding: hunk más claim más rationale, nada más.
4. Baseline: mismo filtro con un LLM juez. Comparar recall, ruido descartado, ECE, costo y latencia.
5. Salida: reporte H1/H6/H3. **Sin H1 aprobada no se escribe la fase 1b.**

### Fase 0b — Spike de perfil de hunk (no bloqueante, en paralelo con 1a)
- Etiquetador por AST y diff (ts-morph o el compilador de TypeScript) para `change_kind`, `touches_public_api`, `touches_error_handling`, `touches_async`, `touches_io` sobre los 100 hunks v2.
- Reutilizar el runner del spike con el set de preguntas nuevo y ground truth multi-etiqueta.
- Salida: reporte H0'.

### Fase 0c — Spike de coherencia intención–cambio (H7, no bloqueante; iniciada el 2026-09-21)
- Dataset de PRs mergeadas (`scripts/dataset/collect-prs.ts` → `datasets/prs.jsonl`) y pares con descripción cruzada (`datasets/coherence-pairs.jsonl`), mismos repos OSS que los hunks.
- Hechos del cambio calculados en código a partir de rutas y conteos (`change-facts.ts`): tipo de archivo, lenguajes, áreas, tamaño en palabras, flags de tests/deps/CI/migraciones. Universal al lenguaje: no parsea código.
- `ChangeSummarizerPort`: un LLM describe el diff a nivel de comportamiento sin ver título ni cuerpo (adapters claude-cli, fake, grabado).
- State de tres capas (`coherence-state.ts`) y set de preguntas (`matches_intent`, `user_facing`, `breaking`, `needs_product_owner`, `risk_level`). Un par por request (NFR-14).
- Runner y reporte con las dos variantes (con y sin resumen) y fixtures grabadas para replay sin costo.
- Salida: reporte H7. Si pasa, la etapa 1 (triage) adopta este state y un archivo `.jevest/context.yml` de producto leído desde la rama base.

### Fase 1b — Pipeline local (CLI)
- Las 6 etapas corriendo sobre un PR dado por URL o por diff local.
- Ports hexagonales, adapters fake y grabado, LLM revisor pluggable.
- Harness de evaluación con datasets y reportes.
- Suite adversarial.

### Fase 2 — GitHub Action
- Action reutilizable (`uses: <org>/jevest@v1`), Node 20.
- Publica comentarios inline, resumen, labels y check status.
- Configuración por archivo `.jevest.yml` en el repo consumidor: umbrales, tools, presupuesto.

### Fase 3 — Aporte público
- Publicar dataset etiquetado (hunks + findings + ground truth) con licencia abierta.
- Publicar benchmark reproducible: Jev vs. LLM juez en la etapa 4.
- Post técnico con resultados, incluidos los negativos.

**Fuera de alcance**: generar la revisión con Jev, revisar imágenes o binarios, reemplazar el review humano, fine-tuning.

---

## 6. Decisión de stack

| Opción | Pros | Contras |
|---|---|---|
| **TypeScript + Node 20 + `@typesafe-ai/sdk`** (elegida) | Runtime nativo de GitHub Actions; stack del equipo; SDK con tipos inferidos; cero fricción para publicar la Action | Sin middlewares oficiales de LangChain (no los necesitamos: el pipeline no es un agent loop) |
| Python + `langchain-typesafe` | Middlewares listos | Los middlewares son para agent loops, no para pipelines por etapas; Action en Python es más pesada |

**Decisión**: TypeScript. El pipeline es un flujo por etapas, no un agente con tools, así que los middlewares de LangChain no aportan. El revisor LLM se llama detrás de un port, con el proveedor configurable.

---

## 7. Arquitectura (hexagonal)

```
┌────────────────────────────────────────────────────────────┐
│  Entrypoints                                               │
│   - cli/  (fase 1)          - action/  (fase 2)            │
├────────────────────────────────────────────────────────────┤
│  Application (etapas del pipeline)                         │
│   TriageStage · HunkSelectStage · ReviewStage              │
│   FindingFilterStage · MergeGateStage · PublishStage       │
│   EvalRunner                                               │
├────────────────────────────────────────────────────────────┤
│  Domain                                                    │
│   PullRequest · Hunk · Finding · Decision                  │
│   Question (Noul | Choice | Score)                         │
│   ConfidencePolicy (bandas por etapa y nivel de riesgo)    │
│   Ports: DecisionPort · ReviewerPort · VcsPort · BudgetPort│
├────────────────────────────────────────────────────────────┤
│  Adapters                                                  │
│   TypeSafeDecisionAdapter · FakeDecisionAdapter            │
│   RecordedDecisionAdapter (fixtures)                       │
│   LlmReviewerAdapter (proveedor configurable) · FakeReviewer│
│   GitHubVcsAdapter · LocalDiffVcsAdapter                   │
└────────────────────────────────────────────────────────────┘
```

Regla: el dominio y las etapas no importan ningún SDK. Cambiar de TypeSafe a otro System One model, o de proveedor LLM, es cambiar un adapter.

---

## 8. Requerimientos funcionales

### FR-1 Puerto de decisión
- FR-1.1 `decide(state, questions)` async, con tipos inferidos por pregunta.
- FR-1.2 Validación previa: `choice` 2..255 opciones, `score` ≥ 2 niveles, `noul` con `criteria` opcional.
- FR-1.3 Toda respuesta trae `request_id`, `usage`, `model`, latencia medida en cliente y `probabilities` completas.
- FR-1.4 Fan-out: construir UN request con N preguntas para UN solo hunk, finding o PR — nunca varios ítems en el mismo request (NFR-14). Claves deterministas por pregunta (`defect_likelihood`, `touches_public_api`, ...). Agrupar varios ítems en un request es válido solo como experimento de costo explícito, nunca como corrida de evidencia.

### FR-2 Triage (etapa 1)
- FR-2.1 State: `{title, description, files_changed: [path], additions, deletions, labels, base_branch}`. Los números se pasan ya clasificados en código (`size: "small" | "medium" | "large"`), nunca crudos.
- FR-2.2 Preguntas: `category` (choice: docs, deps, config, refactor, feature, bugfix, security), `risk` (score: none/low/medium/high/critical), `needs_human` (noul), `contains_injected_instructions` (noul).
- FR-2.3 Regla de salto: `risk ≤ low` con `confidence ≥ umbral_alto` y `contains_injected_instructions < umbral_bajo` → no se invoca al LLM; se publica solo label y resumen de triage.
- FR-2.4 `needs_human` alto siempre agrega label `needs-human-review`, independientemente del resto.

### FR-3 Perfil de hunks (etapa 2)
- FR-3.1 Cada hunk se serializa como `raw-diff` (mejor precisión y menor costo en fase 0) salvo que H0' indique otro formato.
- FR-3.2 Preguntas por hunk (H0'): `change_kind` (choice), `touches_public_api`, `touches_error_handling`, `touches_async`, `touches_io` (nouls). **Prohibido** preguntar por probabilidad de defecto: fase 0 demostró que Jev no puede responderlo y su confianza lo confirma.
- FR-3.3 Solo se omiten del LLM los hunks con `change_kind = rename-or-format` y confianza alta. Todos los demás van al LLM **junto con su perfil**, que el revisor usa como contexto ("este hunk toca API pública y manejo de errores"). Los omitidos se listan en el resumen para auditoría.
- FR-3.4 El troceo es una request por hunk, nunca lotes de varios hunks por request (NFR-14): un PR de K hunks genera K requests de perfil, no `ceil(K/tamaño_de_lote)`.
- FR-3.5 Si H0' falla, la etapa se reduce a metadatos derivados por código (rutas, tamaño, exports cambiados por AST) y no llama a Jev.

### FR-4 Revisión LLM (etapa 3)
- FR-4.1 `ReviewerPort.review(hunks, context) -> Finding[]` con salida estructurada: `{file, line, claim, rationale, suggested_severity}`.
- FR-4.2 Proveedor y modelo configurables por `.jevest.yml`. Sin lógica de Jev dentro de esta etapa.
- FR-4.3 Presupuesto máximo de tokens por PR; al superarlo, la etapa corta y lo informa.

### FR-5 Filtro de findings (etapa 4)
- FR-5.1 State por finding: `{hunk, finding.claim, finding.rationale}`. Sin el resto de findings, para evitar distractores.
- FR-5.2 Preguntas por finding, en un solo request fan-out: `is_real_defect` (noul), `severity` (score: nit/minor/major/critical), `actionable` (noul), `is_style_only` (noul).
- FR-5.3 Bandas: alta → publicar inline; media → cola de revisión humana (resumen colapsado); baja → descartar con registro.
- FR-5.4 Un finding con `severity = critical` NUNCA se descarta por confianza baja: va a cola humana como mínimo.

### FR-6 Merge gate (etapa 5)
- FR-6.1 State: resumen de triage, cantidad de findings publicados por severidad (ya clasificada en código), resultado de CI si está disponible.
- FR-6.2 Pregunta: `safe_to_automerge` (noul).
- FR-6.3 Bandas: alta → check verde con label `jevest:auto-merge-ok`; media → check neutral, pide humano; baja o `contains_injected_instructions` alto en triage → check rojo.
- FR-6.4 **Nunca ejecuta el merge.** Solo emite señal. El merge lo dispara una regla del repo consumidor.

### FR-7 Publicación (etapa 6)
- FR-7.1 Comentarios inline solo para findings de banda alta; edición idempotente en re-runs (no duplicar).
- FR-7.2 Comentario resumen con: decisión de triage, hunks omitidos con probabilidad, findings en cola humana, costo de la corrida.
- FR-7.3 Labels y check status según FR-2 y FR-6.

### FR-8 Harness de evaluación
- FR-8.1 Datasets JSONL versionados en `datasets/`: `hunks.jsonl` (≥ 100 fase 0, ≥ 500 fase 1), `findings.jsonl` (≥ 200), `prs.jsonl` (≥ 50), `adversarial.jsonl` (≥ 30).
- FR-8.2 Métricas: precision, recall, F1, matriz de confusión, ECE, reliability diagram, latencia p50/p95/p99, tokens y costo por etapa.
- FR-8.3 Baseline: la etapa 4 ejecutada con un LLM juez en lugar de Jev, sobre el mismo dataset (H6).
- FR-8.4 Reportes en Markdown y JSON, reproducibles por commit, en `reports/`.

### FR-9 Observabilidad
- FR-9.1 Log estructurado por etapa: `request_id`, preguntas, respuestas, bandas aplicadas, acción tomada.
- FR-9.2 Costo por PR desglosado: Jev vs. LLM.

---

## 9. Requerimientos no funcionales

| ID | Requerimiento | Origen |
|---|---|---|
| NFR-1 | Retries con backoff exponencial y jitter para `429` y `529`; sin retry en `401` y `422` | API reference |
| NFR-2 | Timeout de cliente configurable (default 3 s). Si Jev no responde: triage asume `risk = high`, filtro de findings publica todo como "sin verificar", merge gate emite rojo. **Siempre falla cerrado** | Diseño |
| NFR-3 | Redactor obligatorio antes de cualquier adapter externo: API keys, tokens, `.env`, secretos en diffs. Un hunk que contiene un secreto se marca y no se envía | Docs LangChain |
| NFR-4 | El state de cada etapa incluye solo lo necesario. Nada de mandar el PR completo a cada pregunta | Jaggedness |
| NFR-5 | Toda cuenta, comparación numérica o de fechas se resuelve en código antes de preguntar. A Jev llegan categorías (`size: "large"`), no números | Jaggedness |
| NFR-6 | Criterios explícitos con casos borde escritos; sin dobles negaciones; instrucciones y criterios alineados | Jaggedness |
| NFR-7 | Todo contenido del PR es **untrusted**. La pregunta `contains_injected_instructions` corre en triage y su resultado propaga a merge gate. La suite adversarial (H5) es test de regresión en CI | Jaggedness |
| NFR-8 | Las instrucciones y criterios se escriben en inglés. El contenido del PR va tal cual; H0 mide si el idioma del código o comentarios afecta | Docs State |
| NFR-9 | `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` y la key del LLM solo por secretos de entorno | Docs |
| NFR-10 | Presupuesto por PR (`budgetUsd`) y tope acumulado por período (`spendCap`: por mes UTC o total, con aviso previo en `warnAtUsd`) en `.jevest.yml`; al superar el tope acumulado, el pipeline degrada a Jev-only (sin revisor LLM) y lo informa en el resumen, el check y un label; el acumulado vive en un issue "Jevest spend ledger" del repo | Experimento |
| NFR-11 | Dominio y etapas testeables sin red con adapters fake y grabados | TDD estricto |
| NFR-12 | Runs idempotentes: re-ejecutar sobre el mismo commit no duplica comentarios ni labels | GitHub |
| NFR-13 | Los umbrales de confianza viven en configuración versionada, por etapa y por nivel de riesgo, nunca hardcodeados | Docs Confidence |
| NFR-14 | Una request de Jev contiene UN solo ítem (hunk, finding, PR). Múltiples preguntas por request sí, múltiples ítems por request no: el anclaje por lote hace converger las respuestas (evidencia: `docs/analysis/h0-prime-error-analysis.md` y reportes del 2026-09-19 con lote 1 vs 10) | Análisis de error H0' |

---

## 10. Estrategia de testing (TDD estricto)

1. **Dominio**: tests puros sobre `ConfidencePolicy`, validación de `Question`, serialización de `Hunk` y `Finding`, clasificación de tamaño. Cero I/O.
2. **Etapas**: cada etapa se testea con `FakeDecisionAdapter` y `FakeReviewer` deterministas, forzando cada banda y verificando la acción resultante.
3. **Adapters**: tests de contrato con `RecordedDecisionAdapter` sobre fixtures; un test `@live` que corre solo con API key y regraba fixtures.
4. **Fail-closed**: tests que simulan timeout y `529` en cada etapa y verifican la degradación de NFR-2.
5. **Adversarial**: `adversarial.jsonl` como regresión; un PR inyectado que consiga auto-merge verde rompe CI.
6. **Evaluación**: el `EvalRunner` se testea con un dataset de 5 filas con métricas calculadas a mano.

---

## 11. Estructura del repo

```
jevest/
├── docs/SPEC.md
├── datasets/
│   ├── hunks.jsonl
│   ├── findings.jsonl
│   ├── prs.jsonl
│   └── adversarial.jsonl
├── spike/                       # fase 0, descartable
├── src/
│   ├── domain/
│   ├── application/stages/
│   ├── adapters/
│   ├── cli/
│   └── action/
├── config/jevest.example.yml    # config del pipeline, incluidas bandas por etapa y riesgo
├── action.yml                   # fase 2
├── tests/
└── reports/
```

---

## 12. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| ~~Jev no entiende código (H0 falla)~~ **Materializado el 2026-09-19** | Pivote ejecutado (v0.3) | Jev fuera del juicio de defectos; rol reducido a superficie, texto y metadatos |
| El filtro de findings tampoco funciona (H1 falla) | Jev no aporta al review; el proyecto queda como benchmark negativo | Publicar el resultado negativo con datasets y fixtures (fase 3); evaluar Jev solo en triage y merge gate |
| Ground truth de findings sesgada (solapamiento de líneas con el fix) | Findings reales fuera del rango del fix contados como ruido | Verificación manual de muestra; reportar tasa de desacuerdo humano vs. heurística |
| Modelo en early access, sin SLA ni rate limits publicados | Runs inestables en CI | NFR-1, NFR-2, medir 429/529 como métrica |
| Calibración peor de lo prometido | Bandas inútiles | Reliability diagram desde fase 1; umbrales conservadores y ajustables |
| Inyección en el PR pasa el gate | Auto-merge indebido | NFR-7, FR-6.4 (nunca mergea), H5 en CI |
| Diffs grandes superan el contexto | Silencios en la revisión | FR-3.4 troceo; hunks omitidos siempre reportados |
| Sesgo del dataset (lo etiquetamos nosotros) | Métricas optimistas | Publicar dataset y criterio de etiquetado; invitar contribuciones |
| API `experimental` o SDK cambia | Rompe adapters | Pinear versiones; contrato de adapter cubierto por tests grabados |

---

## 13. Decisiones tomadas (2026-09-18)

| Tema | Decisión | Consecuencia |
|---|---|---|
| API key de TypeSafe | No disponible todavía; hay que pedir early access | Fase 0 arranca con `RecordedDecisionAdapter` y fixtures sintéticas; las llamadas reales se habilitan al llegar la key |
| Dataset del spike | Repos OSS en TypeScript, elegidos por el equipo, a partir de commits de fix con su estado previo | Ground truth semiautomática: hunk previo al fix = defecto; hunks de commits no-fix = benigno. Etiquetado manual de verificación |
| LLM revisor y juez | Ambos proveedores (Anthropic y OpenAI), configurables por `.jevest.yml` | `ReviewerPort` con dos adapters desde fase 1 |
| Presupuesto | Menos de USD 20 para spike y fase 1 | Corte automático en NFR-10; el gasto real es el LLM revisor, Jev es despreciable |

### Decisiones del 2026-09-19

| Tema | Decisión | Consecuencia |
|---|---|---|
| Dataset v1 con ruido | Regenerado como v2: solo código fuente, sin tests, docs ni config, benignos de los mismos directorios que los defectos | Precisión de raw-diff subió de 0.57 a 0.84; el confound de rutas desapareció |
| H0 fallida con datos limpios | **Pivote aprobado por el usuario**: Jev no juzga defectos | §4.2, FR-3 reescrito, fases 1a y 0b nuevas |
| Orden de trabajo | Fase 1a (filtro de findings) es la hipótesis central y bloqueante; 0b corre en paralelo y no bloquea | Presupuesto del LLM revisor se gasta en 1a |
| Corridas con `--limit` | Nunca son evidencia: muestra estratificada con semilla y advertencia impresa | Solo smoke tests |

### Decisiones del 2026-09-20

| Tema | Decisión | Consecuencia |
|---|---|---|
| Tercer proveedor LLM | DeepSeek (`deepseek-v4-pro` por defecto, `deepseek-flash` como opción barata) vía el SDK de OpenAI apuntado a `https://api.deepseek.com` | Cuarto adapter de `ReviewerPort`; input `deepseek-api-key` en la Action; `pnpm findings --provider deepseek` |
| Salida estructurada en DeepSeek | Solo soporta `json_object`, no `json_schema`; el adapter valida el JSON contra `reviewOutputSchema` del lado cliente y trata contenido vacío o truncado como `ReviewerParseError` del hunk, nunca como "sin findings" | Un hunk con respuesta inválida queda registrado con error en el resumen; el filtro no ve findings inventados |
| Costo DeepSeek | Tarifas PICO (01–04 y 06–10 UTC, lun–vie) en la tabla de pricing; cache hit y miss se reportan por separado (`prompt_cache_hit/miss_tokens`) para no cobrar dos veces | El corte por `budgetUsd` nunca subestima; fuera de pico el costo real es ~la mitad |

### Pendiente

- Nombre y organización para publicar la Action y el dataset (fase 3).

---

## 14. Fuentes

- [LangChain — Building a harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev)
- [TypeSafe — Introducing System One models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe docs — Quickstart](https://docs.typesafe.ai/introduction/quickstart)
- [TypeSafe docs — API reference](https://docs.typesafe.ai/api)
- [TypeSafe docs — State](https://docs.typesafe.ai/concepts/state)
- [TypeSafe docs — Confidence](https://docs.typesafe.ai/confidence)
- [TypeSafe docs — Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [TypeSafe docs — JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [LangChain docs — TypeSafe provider](https://docs.langchain.com/oss/python/integrations/providers/typesafe)
