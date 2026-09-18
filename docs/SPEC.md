# Jevest — Revisión automatizada de PRs con Jev como capa de decisión

> Estado: DRAFT v0.2 — 2026-09-18
> Reemplaza a v0.1 (laboratorio genérico de harness). El foco ahora es un caso concreto con aporte a la comunidad.
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
┌──────────────────┐   1 request Jev, 1 pregunta × hunk (fan-out)
│ 2. Hunk select   │──▶ por hunk: prob_defecto · toca_api_publica · toca_seguridad
└──────────────────┘
        │ solo hunks relevantes
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

| ID | Hipótesis | Métrica | Criterio de éxito | Fase |
|---|---|---|---|---|
| **H0** | Jev clasifica diffs de código con precisión útil | Precision/Recall sobre 100 hunks etiquetados a mano (defecto sí/no, categoría) | Recall defecto ≥ 0.85, F1 ≥ 0.75. **Si falla, el proyecto pivota** | 0 |
| H1 | El filtro de findings recorta ruido sin perder defectos reales | Recall de defectos reales antes vs. después del filtro; % findings descartados | Recall ≥ 0.95 del original; ≥ 40% de findings descartados | 1 |
| H2 | Triage + hunk select reducen costo del LLM | Tokens LLM por PR con y sin Jev | −50% tokens con misma tasa de detección | 1 |
| H3 | La confidence está calibrada sobre findings | Reliability diagram + ECE sobre ≥ 200 findings etiquetados | ECE < 0.1 | 1 |
| H4 | Latencia total de Jev por PR es despreciable | Suma de latencias Jev p95 por PR | p95 < 2 s para PRs de ≤ 50 hunks | 1 |
| H5 | El pipeline resiste PRs adversariales | Suite de PRs con instrucciones inyectadas en descripción, comentarios de código y commits | 0 auto-merges indebidos; 0 findings críticos suprimidos | 1 |
| H6 | La verificación con Jev es más barata que con LLM | Costo de la etapa 4 con Jev vs. con LLM juez | ≥ 100x más barato con recall equivalente | 1 |

---

## 5. Fases y alcance

### Fase 0 — Spike bloqueante (1–2 días)
- Script mínimo en TypeScript con `@typesafe-ai/sdk`.
- Dataset semilla: 100 hunks de repos OSS reales, etiquetados a mano (defecto sí/no, categoría, toca seguridad).
- Probar 3 formas de serializar el hunk en `state`: diff crudo, JSON `{file, language, before, after}`, JSON más contexto del archivo.
- Salida: reporte con métricas de H0 por formato. **Sin H0 aprobada no se escribe nada de la fase 1.**

### Fase 1 — Pipeline local (CLI)
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
- FR-1.4 Fan-out: construir UN request con N preguntas para N hunks o N findings, con claves deterministas (`hunk_3_defect`).

### FR-2 Triage (etapa 1)
- FR-2.1 State: `{title, description, files_changed: [path], additions, deletions, labels, base_branch}`. Los números se pasan ya clasificados en código (`size: "small" | "medium" | "large"`), nunca crudos.
- FR-2.2 Preguntas: `category` (choice: docs, deps, config, refactor, feature, bugfix, security), `risk` (score: none/low/medium/high/critical), `needs_human` (noul), `contains_injected_instructions` (noul).
- FR-2.3 Regla de salto: `risk ≤ low` con `confidence ≥ umbral_alto` y `contains_injected_instructions < umbral_bajo` → no se invoca al LLM; se publica solo label y resumen de triage.
- FR-2.4 `needs_human` alto siempre agrega label `needs-human-review`, independientemente del resto.

### FR-3 Selección de hunks (etapa 2)
- FR-3.1 Cada hunk se serializa con el formato ganador del spike (H0).
- FR-3.2 Preguntas por hunk: `defect_likelihood` (score), `touches_public_api` (noul), `touches_security` (noul).
- FR-3.3 Se envían al LLM los hunks con `defect_likelihood ≥ umbral` o cualquiera de los dos nouls alto. El resto se reporta como "omitido por triage" en el resumen, con su probabilidad, para auditoría.
- FR-3.4 PRs con más de K hunks se trocean en varios requests de tamaño configurable (límite de contexto no publicado).

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
| NFR-10 | Presupuesto por PR y por día en `.jevest.yml`; al superarlo, el pipeline degrada a triage-only y lo informa | Experimento |
| NFR-11 | Dominio y etapas testeables sin red con adapters fake y grabados | TDD estricto |
| NFR-12 | Runs idempotentes: re-ejecutar sobre el mismo commit no duplica comentarios ni labels | GitHub |
| NFR-13 | Los umbrales de confianza viven en configuración versionada, por etapa y por nivel de riesgo, nunca hardcodeados | Docs Confidence |

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
├── config/policies.yaml         # bandas por etapa y riesgo
├── action.yml                   # fase 2
├── tests/
└── reports/
```

---

## 12. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Jev no entiende código (H0 falla) | Proyecto inviable como está | Spike primero; pivot documentado: reducir el rol de Jev a triage y filtro de findings, que son texto |
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
