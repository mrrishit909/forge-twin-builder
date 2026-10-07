# FORGE: one command per job. Ports: web 8521, API 8520, Postgres 55520, mail sink 8522, MQTT 18830.
.PHONY: dev seed test e2e e2e-docker load-test reset build typecheck openapi record

dev:        ## full stack in Docker: web, API, Postgres, Mosquitto, plant simulator, mail sink, OpenTelemetry collector
	docker compose up --build -d --wait
	@echo "web http://localhost:8521  api http://localhost:8520/openapi.json"

seed:       ## regenerate the synthetic template and evaluation, migrate and reseed tenants (owner connection)
	node data/simulators/generate.ts
	node apps/api/src/migrate.ts && node apps/api/src/seed.ts --reset

test:       ## unit tests (coverage >= 85% on domain logic) + API tests against a throwaway Postgres and Mosquitto
	docker compose --profile test run --rm --build test

e2e:        ## Playwright against the static export (needs Google Chrome)
	node scripts/copy-fixtures.ts && npm run build -w @forge/web
	npx playwright test

e2e-docker: ## the section 17 journey against the running Docker stack (API mode)
	E2E_BASE=http://localhost:8521 npx playwright test demo

load-test:  ## HTTP, simulation and 2,000 WebSocket subscribers against an API on 8523 (start it with RATE_LIMIT=1000000 PORT=8523)
	node tests/performance/load.ts http://127.0.0.1:8523 32 10 2000

reset:      ## drop all data and reseed
	docker compose down -v
	docker compose up --build -d --wait

build:      ## static export for GitHub Pages (base path = the projects site)
	NEXT_PUBLIC_BASE_PATH=/projects/forge-twin-builder/demo npm run build -w @forge/web

typecheck:
	npx tsc -p . && (cd apps/web && npx tsc --noEmit -p .)

openapi:    ## write docs/openapi.json from the route schemas
	node -e "import('./apps/api/src/server.ts').then(async (m) => { const app = await m.build({ logger: false, hub: null }); await app.ready(); require('fs').writeFileSync('docs/openapi.json', JSON.stringify(app.swagger(), null, 1)); await app.close(); process.exit(0); })"

record:     ## 2-4 minute captioned demo recording (Playwright video -> docs/video/demo.mp4)
	node scripts/record-demo.ts
