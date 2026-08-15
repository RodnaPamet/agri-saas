# Scheme catalogues — content without an ingestion path

**These four YAML files currently load into nothing.** `prisma/catalog-loader.ts`
still parses and validates them into a `CatalogFile` shape, but the applier that
wrote that shape to the database (`prisma/catalog-applier.ts`) was deleted by GRC
teardown phase 3, because all three of its write targets — `Framework`,
`FrameworkRequirement` and `FrameworkPack` — were dropped with the rest of the
inherited GRC schema.

The loader is therefore a validator with no consumer. It is kept, and this file
exists, rather than deleting the lot, because the two halves have very different
value:

| File | What it is |
|---|---|
| `bg-babh-plant-protection.yaml` | БАБХ plant-protection scheme — **agri content** |
| `eu-organic-2018-848-demo.yaml` | EU organic regulation 2018/848 — **agri content** |
| `globalgap-ifa-demo.yaml` | GlobalG.A.P. IFA — **agri content** |
| `iso27001-2022-demo.yaml` | ISO/IEC 27001 — GRC, inherited, no longer relevant to this product |

The three agri catalogues describe real certification schemes this product is
plausibly meant to support. Deleting them would throw away authored content to
tidy up a broken wire; that is a product decision, not a teardown one, so the
teardown did not make it.

## If you are giving them a home

`SupportScheme` is NOT that home — it models subsidy measures, not standards, and
re-pointing the applier at it would be inventing behaviour rather than restoring
it. A new destination needs a model with the requirement-tree shape the YAML
already carries (scheme → requirement → sub-requirement), and the applier can
then be rewritten against it; `git show HEAD~1:prisma/catalog-applier.ts` has the
original upsert logic if it is useful as a starting point.

## If you are deleting them

Delete `prisma/catalog-loader.ts`, `tests/unit/catalog-loader.test.ts`, this
directory, and this file together. Note that `catalog-loader.test.ts` currently
passes — it exercises the parser, which still works. A green test here is not
evidence that anything is wired up.
