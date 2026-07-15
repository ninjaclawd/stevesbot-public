# Knowledge retrieval and feedback

## The short version

StevesBot does not remember by changing an AI model's brain. It remembers by writing reviewed, structured notes to local SQLite databases and searching those notes during future support work.

That distinction matters: an operator can inspect, correct, export, or delete the memory without retraining a model.

## The data sources

| Source | What it contains | Trust level | Typical use |
| --- | --- | --- | --- |
| Current thread | The active question and recent conversation | Untrusted user input | Understand context and avoid repeating advice |
| Approved support records | Compact question/answer pairs from accepted workflows | High, but may age | Find a previously reviewed answer |
| Mined knowledge | Problem, solution, product, keywords, and resolution signals from selected threads | Medium until reviewed | Match a new issue to a solved pattern |
| Product documentation | Markdown/readmes from allowed repository paths | High for documented behavior | Explain settings and supported workflows |
| Source code | Files from explicitly allowed repository paths | High for implementation details | Verify exact flags, defaults, and behavior |
| Discord archive | Optional local history grouped by thread | Raw and privacy-sensitive | Recover context when curated sources are insufficient |
| Generated learnings | Reports and reference notes produced by chores | Provisional | Suggest gaps or material for human review |
| Web search | Optional external results | Variable | Time-sensitive facts not found locally |

The public repository contains no real rows from these data sources.

## What happens when a question arrives

```text
Discord message
      |
      v
route check -> triage -> retrieve reviewed knowledge -> inspect docs/code if needed
                                          |
                                          v
                                   evidence-backed draft
                                          |
                                          v
                                      validation
                                          |
                                          v
                                     human review
                                          |
                       +------------------+------------------+
                       |                  |                  |
                     send               edit              reject
                       |                  |                  |
                       +------ feedback / searchable record +
```

The drafter normally begins with curated support and mined knowledge because those sources describe user-facing problems. It searches raw source code when an exact technical detail is needed. Raw Discord history comes later because it is noisier, less private, and less reliable.

Retrieval is full-text search, not mystical understanding. Search terms come from the current issue, and the model may make a small number of purposeful tool calls. Tool results are included as evidence for the draft. When evidence is missing, the correct result is a clarification question or an honest “not enough information,” not an invented fix.

## The feedback loop

There are several separate signals:

1. **Pipeline approval** means the validation stage found the draft acceptable for review.
2. **Reviewer usage** records whether a human sent the draft unchanged, edited it, or skipped it.
3. **Direct feedback** records positive or negative human judgment about a workflow.
4. **Resolution signals** such as “that fixed it” may link back to an answer, but should only be accepted when attribution is clear.
5. **Scheduled curation** mines promising resolved threads, finds weak entries, and reports knowledge gaps.

These signals should not be collapsed into one score. A technically valid draft can still be edited for tone; a sent answer can later become outdated; a friendly “thanks” might refer to another human's message.

The safest rule is conservative attribution: only connect a resolution message to an earlier answer when it is from the same user, in the same conversation, and the bot's answer was actually delivered to the source conversation.

## How mined knowledge is created

A mining job reads candidate threads and produces a compact record containing fields such as:

- a neutral summary;
- the problem statement;
- the working solution;
- product/category labels;
- useful search keywords and error signals;
- whether the thread appears resolved;
- provenance pointing to the local source record.

The record is indexed for full-text search. Threads intentionally reviewed and rejected should be recorded as reviewed so they are not offered repeatedly by every scheduled run.

Mining is deliberately lossy: it keeps the reusable support lesson, not every message. This improves retrieval and reduces privacy exposure, but a human should still review summaries before treating them as durable documentation.

## Generated reference documents

Chores can build FAQs, gap reports, or updated reference notes. Generated material is not automatically authoritative. Empty, truncated, refusal-only, or obviously malformed output should be rejected, and a failed generation must not overwrite the last good document.

Use generated documents as proposed edits. Promote them to trusted route instructions only after review.

## Keeping knowledge healthy

Useful maintenance checks include:

- the number of knowledge rows matches the full-text index;
- recent approved answers are becoming searchable;
- repeatedly skipped drafts point to instruction or retrieval gaps;
- duplicate and stale entries are flagged;
- mining backlogs do not repeatedly include intentionally rejected threads;
- repositories and documentation clones pull successfully;
- database size, disk use, queue age, and logs remain bounded;
- model fallbacks are actually reachable.

More data is not automatically better. A small set of clear, reviewed solutions usually beats a large archive of contradictory conversations.

## Privacy choices for operators

- Keep raw transcripts for the shortest useful period.
- Store attachments separately and delete them on a schedule.
- Limit the archive to support channels with a clear operational reason.
- Do not send private message content to a cloud model unless your policy permits it.
- Remove names, IDs, URLs containing IDs, and unique personal details from durable summaries.
- Keep the dashboard private; it can reveal workflow text and operational metadata.
- Treat database backups with the same care as the live Discord server.
