# Protected-object guard: Graph path forms checked live (2026-10-22)

> Licensing finding of 2026-10-22: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

The protected-object guard refuses, or treats as sensitive, every path form below whatever Microsoft Graph does with
it (`CHANGELOG.md` › Protected-object guard: keys and path spellings). Checked live in the validation tenant on
2026-10-22, read-only (GET, and `$batch` with one GET sub-request), as the automation identity:

| Form                                                                             | Graph v1.0 | What it means for the guard                                               |
| -------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `groups(uniqueName='sg-adminforge-…')`                                           | 200        | Alternate keys name AdminForge's own groups: refused (`object_not_by_id`) |
| `directoryObjects/microsoft.graph.group(uniqueName='…')`                         | 200        | A key after a cast works too: refused                                     |
| `/groups//{id}`, `/groups/{id}//members`                                         | 200        | Graph collapses empty segments: read as one `/`, still sensitive          |
| `/groups/{32 hex digits}`                                                        | 200        | Ids without hyphens work: refused in paths, matched as ids in bodies      |
| `/GROUPS/{id}`                                                                   | 200        | Collection names are case-insensitive: matched case-insensitively         |
| `/directoryObjects/{id}/microsoft.graph.group`                                   | 200        | Casts are ignored when matching                                           |
| `/$Batch`, `/$batch/`, `/%24batch`, `/$BATCH`                                    | 200, batch | Routed to `$batch`: checked request by request, sent as `/$batch`         |
| `//$batch`, `/$batch;x`, `/%20$batch`                                            | 400        | Not routed; refused anyway                                                |
| `/groupſ/{id}`, `/userſ/{upn}`                                                   | 400        | Graph doesn't fold like .NET here; the guard folds anyway (fail closed)   |
| `/groups/(uniqueName='…')`, `/groups/uniqueName='…'`, `/groups (uniqueName='…')` | 400        | Rejected by Graph; refused anyway                                         |

Writes in these forms were not sent: the reads show how Graph parses a path, and the guard refuses the write before it
leaves AdminForge.
