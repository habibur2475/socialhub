# Intelligence service (Python + FastAPI)

Status: **scaffolded, not yet wired.**

## Why separate, and why Python

Recommendation, ranking and moderation models change far more often than the
product's transactional core, and they want a different feedback loop: notebook
experiments, offline evaluation, a model registry. Keeping them in the Python
service means a model deployment cannot destabilise authentication, payments or
the feed's read path.

## Responsibilities

| Concern                | Input                                                   | Output                     |
| ---------------------- | ------------------------------------------------------- | -------------------------- |
| Feed ranking           | candidate post ids, viewer profile, interaction history | scored, ordered ids        |
| Creator recommendation | viewer interests                                        | creator ids with reasons   |
| Ad relevance           | campaign targeting, audience profile                    | relevance in basis points  |
| Moderation             | text / media reference                                  | labels, confidence, action |
| Search ranking         | query, candidate documents                              | rerank scores              |

## Contract with the API

- **Batch, not per-item.** Endpoints accept N items and return N scores in one
  round trip; per-item calls would dominate feed latency.
- **Fail open to a deterministic fallback.** The API ships a cheap ordering
  (recency × engagement decay, see `timeDecayBps` in the kernel) and uses it when
  the service is slow or unavailable. A recommendation outage must degrade the
  feed, not break it.
- **Explanations are part of the response.** Every score carries the reason codes
  that produced it, so a ranking decision is auditable — including to the user.

## Layout

```
app/
  main.py                 FastAPI composition root
  api/                    routers (feed, creators, ads, moderation)
  ranking/                scoring models and feature assembly
  clients/                API and feature-store clients
  models/                 serialised artefacts + registry
  evaluation/             offline metrics and regression gates
tests/
```
