# Disclosure of AI-assisted development

The brief asks for AI prompts and a disclosure of AI-assisted development. This is that disclosure.

## How this project was built

This project was built with **Claude Code**, Anthropic's agentic coding tool, running the **Claude Opus 5.5** model. The work happened in one directed session; the author supplied the assessment brief and the requirements.

| Area | How it was produced |
|---|---|
| Architecture, backend (NestJS API and workers), Python processor, database schema, extraction, validation, search, cross-verification | Written by the agent in the main session, then iterated against measurements: OCR and extraction accuracy were benchmarked on the dev split after each change. |
| Synthetic labelled dataset generator (`eval/`) | Written by a parallel sub-agent from a written specification ([prompt](prompts/development-prompts.md#2-sub-agent-labelled-dataset-generator)). Its own QA script checks that every label is printed in the document. |
| Web frontend (`apps/web`) | Written by a parallel sub-agent from a written specification ([prompt](prompts/development-prompts.md#3-sub-agent-web-frontend)), then integrated and checked end to end. |
| Tests, evaluation runner, documentation | Written by the agent. |
| Decisions made by the author | The task itself, delivering a complete working system, and using the author's **Azure OpenAI** deployment (`gpt-6-astra`) as the production LLM provider. The Anthropic adapter is kept as an alternative. |

Every metric in [`EVALUATION.md`](EVALUATION.md) was **measured by running the system** through its REST API with `eval/run_eval.py`. The raw results are in `eval/results/*.json`. No number was written by hand.

The prompts that directed the development are in [`prompts/development-prompts.md`](prompts/development-prompts.md).

## AI inside the product (runtime)

| Use | Model | Data handling |
|---|---|---|
| Invoice field extraction, called only for hard cases in the default cascade mode | Azure OpenAI `gpt-6-astra` (Responses API, strict JSON schema), or Anthropic `claude-opus-5-5` | Document text, plus page images when OCR quality is low. `store: false` on Azure. The model gets no tools. Its output is schema-constrained and grounded against the source before use. |
| Semantic search embeddings | `BAAI/bge-small-en-v1.5`, local (fastembed / ONNX) | Runs inside the processor container; nothing leaves the deployment. |
| OCR | Tesseract 5 (LSTM), local | Runs inside the processor container. |

The exact runtime prompts and the output schema are in [`prompts/runtime-prompts.md`](prompts/runtime-prompts.md).

## Safeguards against AI errors

- **The model cannot invent values.** Every value must be traceable to the document text (numerically for amounts and dates, fuzzily for names), or it is discarded and logged.
- **Deterministic extraction runs on every document**, and disagreements with the model are surfaced to reviewers.
- **Low confidence, conflicts, vision-only values and any validation error route the invoice to manual review.** Approval is blocked while errors remain.
- **The deterministic system works with no LLM at all** (`LLM_PROVIDER=none`), and that mode is evaluated separately.

## Data used

Only synthetic, generated documents were used for development and evaluation; company names come from Faker. No real customer documents were used.
