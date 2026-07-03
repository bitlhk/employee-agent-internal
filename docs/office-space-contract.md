# Office Space Contract

## Product Shape

Office Space is the entry for structured office tasks. Files is the place for browsing, downloading, and managing persisted artifacts.

The first version uses capability cards instead of a free-form universal chat entry. This keeps the user path explicit and lets future capabilities be developed independently.

## Capability Contract

Each office capability should follow the same user-facing flow:

1. Select capability.
2. Provide inputs: upload files, select files from Files, record audio, or enter text requirements.
3. Generate a preview.
4. Confirm or save output.
5. Persist artifacts to Files.

Capabilities may customize their input fields and preview type, but should keep the same page rhythm: input, preview, artifacts.

```ts
type OfficeCapability = {
  id: string;
  title: string;
  description: string;
  status: "ready" | "planned";
  acceptedFiles: string[];
  previewType: "markdown" | "tablePlan" | "outline" | "checklist" | "file";
  outputTypes: string[];
};
```

## Artifact Contract

All generated files must be persisted under the user's workspace. Temporary-only download links are not enough.

New office capabilities should write to:

```text
office/{capability}/{taskId}/
```

Examples:

```text
meeting-notes/20260517-client-visit/
  audio.mp3
  transcript.md
  summary.md

office/excel-fill/20260517-customer-sheet/
  inputs/customer-sheet.xlsx
  inputs/customer-background.pdf
  request.md
  outputs/fill-plan.md
  outputs/filled.xlsx
  outputs/fill-result.md

office/ppt-create/20260517-training-deck/
  inputs/template-huawei-light.pptx
  inputs/source-notes.md
  request.md
  outputs/outline.md
  outputs/slides.pptx
  outputs/ppt-result.md
```

Existing meeting notes may keep reading historical `meeting-notes/` records. New capabilities should use `office/...`.

## OpenClaw Usage

OpenClaw is the default reasoning and generation runtime for office tasks.

Workforce Agent Platform owns:

- file upload and download
- workspace persistence
- file parsing where needed
- preview normalization
- validation before writing final files

OpenClaw owns:

- summarization
- report drafting
- outline generation
- reasoning over provided context

For strong-format artifacts such as PPTX, OpenClaw should produce structured content and reviewable plans. Workforce Agent Platform owns the final binary file generation so output paths, downloads, validation, and persistence stay deterministic.

For hot-topic or latest-trend PPT requests, OpenClaw may search/fetch web evidence when the runtime exposes those tools. The outline must preserve source titles, URLs, dates, and uncertainty. If search tools are unavailable, the outline should explicitly ask the user to provide source material instead of fabricating facts.

## Obsidian-Inspired Methods

We borrow mechanisms, not source code:

- Project-like isolation: each task has its own task directory and runtime session.
- Custom Commands: each capability is a prompt template with typed inputs.
- Add Context: files and user instructions are explicit task inputs.
- Composer Preview: generated content is previewed before writing final files.

## Baseline Prompt

```text
You are an enterprise office assistant. Use only the provided materials and the user's request.

Rules:
1. Do not invent facts that are not present in the materials.
2. If information is missing, list it explicitly.
3. Produce structured, reviewable output suitable for business use.
4. Prefer previewable formats: Markdown, table change plans, slide outlines, or checklists.
5. Do not claim that a file was modified unless the system confirms it was written.
```

## First Version Scope

Ready:

- Meeting Notes: reuse the existing implementation.
- Excel Fill: upload spreadsheet and context files, generate a Markdown fill plan, then confirm write-back to a copied Excel file.
- PPT Creation: select a built-in or uploaded template, generate a page outline, then confirm generation of a PPTX artifact.

Planned UI shell:

- More office capabilities should reuse the same task rhythm before adding specialized UI.

Not in first version:

- generic report writing
- generic report revision
- guaranteed full-fidelity Excel style-preserving write-back
- high-fidelity PPT rendering
- professional finance workflows such as credit report writing or loan document review

## Excel Fill Contract

Excel Fill follows the same rhythm as Meeting Notes:

1. Upload one workbook into `office/excel-fill/{taskId}/inputs/`.
2. Optionally upload background files into the same `inputs/` directory.
3. User enters a fill requirement or chooses a preset requirement.
4. Workforce Agent Platform calls OpenClaw in a task-scoped session to produce `outputs/fill-plan.md`.
5. User reviews the plan.
6. User confirms write-back; OpenClaw writes a copied workbook to `outputs/filled.xlsx` and a processing note to `outputs/fill-result.md`.

The original workbook must never be overwritten. Low-confidence or unsupported fields should stay blank and be listed in the processing note.

## PPT Creation Contract

PPT Creation must not start from a free-form “make a PPT” prompt. It needs a template and a review step.

1. User selects a built-in template or uploads a custom PPT/PPTX template.
2. User optionally uploads source materials.
3. User enters a presentation requirement.
4. Workforce Agent Platform copies the selected template into `office/ppt-create/{taskId}/inputs/`.
5. OpenClaw generates `outputs/outline.md` first.
6. User confirms the outline.
7. Workforce Agent Platform parses `PPT_BLUEPRINT_JSON` from the outline, or falls back to the Markdown page plan.
8. Workforce Agent Platform generates `outputs/slides.pptx` with a fixed business layout generator and writes `outputs/ppt-result.md`.

The built-in first template is `huawei-light`, stored at:

```text
data/office-templates/huawei-light.pptx
```

The first version treats user-uploaded templates as style/reference templates. Complex master/layout fidelity, custom charts, animations, and exact master reuse are best effort; the priority is a valid PPTX, clear structure, and artifact persistence. OpenClaw does not need a PPTX authoring Skill for this product path.

Supported first-party visual components:

- content cards
- compare two-column
- process flow
- timeline
- 2x2 matrix
- KPI cards
- bar chart
- simple table

OpenClaw should set `visualIntent` and optional `visualData.items` in `PPT_BLUEPRINT_JSON`; Workforce Agent Platform maps those into stable PPTX shapes.
