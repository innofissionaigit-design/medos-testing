# AI assistant

## What it is
A drafting aid for the doctor treating a patient. On the visit page a doctor can ask for:
- **Summary of earlier visits**: the problem, diagnosis, medicines and advice from the patient's earlier *signed* visits that this doctor may see, with allergies first.
- **Draft advice for this visit**: advice in simple language, written only from the diagnoses and medicines already on the visit.

It is a **draft for the doctor to read and change**. It never diagnoses, never suggests or changes a medicine, dose or test, and never writes to the chart: the doctor copies what they choose into the note themselves, and tells the system whether the draft was used (perhaps after editing it) or discarded.

Not built, on purpose: AI diagnosis, AI prescriptions, ambient scribe, deterioration prediction, any AI for nurses or patients, or any AI that acts without a doctor.

## Off until the hospital says so
The assistant is available only when all four are true: the hospital has connected its own AI provider (Administration → AI assistant), an administrator confirmed that the agreement with that provider allows sending de-identified visit data to it, the connection test has passed, and the assistant is switched on (the `AI_ASSISTANT_ENABLED` setting, also a button on that page). Changing the provider, its address, the key or the model resets the test, and changing the provider or its address also resets the confirmation. A key already saved is never sent to a different provider address unless it is entered again.

## What is sent to the provider
Built on the server from the visit's own data, never from what the browser sends: the patient's age and sex, active allergies, and for each visit the complaint, diagnoses, medicines and advice. Before it leaves, names (the patient's, the guardian's and the emergency contact's), phone numbers, e-mail addresses, record numbers and long digit strings are removed from free text. This is **best effort**: a name typed in an unusual way, or an identifying detail in the middle of a sentence, can get through. It is still health information, so use a provider your agreement allows. Every request starts with fixed instructions: use only the material, do not diagnose, do not suggest or change any medicine, dose or test, say what is missing instead of guessing.

Size limits: about 6,000 characters in, 700 tokens out; a doctor can ask 20 times an hour.

## Providers
- **Anthropic (Claude)**: the Messages API, with your key and the model name from your account (an optional gateway address in front of it).
- **Another service**: one POST with JSON `{ system, user, maxTokens }` (and `Authorization: Bearer <key>` if a key is set) answering `{ text }`. A service that wants another shape needs a small adapter in front of it.

Addresses must be https (plain http to this computer is accepted only in a test setup). The key is encrypted and never shown again.

## Records and audit
Each draft is stored with who asked, the visit, the task, the provider host, the model and the text, so there is a record of what the AI wrote. It cannot be changed or deleted; only its review (used or discarded, edited or not) is recorded, once. A doctor sees only their own drafts, and only for visits they are allowed to see. The audit log records requests and reviews without any clinical text. Audit events: `AI_CONFIG_SAVED`, `AI_CONFIG_TESTED`, `AI_CONFIG_DISCONNECTED`, `AI_DRAFT_REQUESTED`, `AI_DRAFT_REVIEWED`.

## Permissions
`AI_USE` (doctors) and `AI_CONFIGURE` (administrator).

## API
`GET/PUT/DELETE /ai/config`, `POST /ai/config/test`, `GET /ai/status`, `POST/GET /encounters/:id/ai/drafts`, `POST /ai/drafts/:id/review`.

## Known limitations
No clinical validation of the assistant's output has been done: it can be wrong or incomplete, which is why a doctor reads it first. The de-identification is best effort. The assistant does not read lab or radiology reports, images or documents, does not support Bengali or Hindi drafting yet, and has no way to flag a draft as unsafe beyond the doctor discarding it. A hospital should decide its own policy (who may use it, whether drafts may be shown to patients) before switching it on. See `docs/backlog.md`.
