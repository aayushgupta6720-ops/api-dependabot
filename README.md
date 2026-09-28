# dashboard-data

State for the scheduled agent run (`.github/workflows/agent.yml` on `main`).
Each run restores these files, then commits what changed:

- `run-log.jsonl`: one line per run of the agent
- `.changelog-state.json`: the last release whose breaking changes were all handled
- `eval-results/`: one file per run of the eval harness

The dashboard at https://aayushgupta6720-ops.github.io/api-dependabot/ is built from them.
