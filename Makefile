.PHONY: up down logs dev api web test test-api test-processor test-e2e test-web dataset eval eval-hybrid bench

up:            ## Build and start the whole stack (http://localhost:3000, API docs http://localhost:4000/docs)
	docker compose up --build -d
	@echo "Web: http://localhost:3000   API: http://localhost:4000/docs"

down:
	docker compose down

logs:
	docker compose logs -f api worker processor

dev:           ## Infra + processor in Docker (hot reload); run `make api` and `make web` in other terminals
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis processor

api:
	cd apps/api && npm install && npx nest build && APP_ROLE=all node dist/main.js

web:
	cd apps/web && npm install && API_URL=http://localhost:4000 API_KEY=dev-admin-key-change-me npm run dev

test: test-api test-processor   ## Unit + integration tests (API and processor)

test-api:
	cd apps/api && npx jest --config jest.config.js

test-processor:
	docker compose --profile test run --rm processor-test

test-e2e:      ## Black-box API tests against a running stack (E2E_API_URL, default http://localhost:4000)
	cd apps/api && npx jest --config test/jest-e2e.config.js --runInBand

test-web:
	cd apps/web && npx playwright test e2e/smoke.spec.ts

dataset:       ## Regenerate the labeled evaluation dataset (deterministic, seed 42)
	cd eval && uv run python generate_dataset.py --profile standard --out data --clean

eval:          ## End-to-end evaluation (see docs/EVALUATION.md for the isolated eval API setup)
	cd eval && uv run python run_eval.py --label rules-only --reset

bench:         ## Offline extraction benchmark on cached processor output
	cd apps/api && TS_NODE_PROJECT=tsconfig.scripts.json TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/extraction-bench.ts --categories pdf_digital,pdf_scanned,image,multi_invoice_pdf,xlsx,xls,csv --split all
