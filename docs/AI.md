# Optional AI reading assistant

The userscript works immediately with AI disabled. To generate overviews or contextual definitions, run the Python bridge on the same computer as Chrome and pair it with Tampermonkey. The bridge connects to a model you choose. No credentials, model weights, or hosted account come with the application.

## Local setup

1. Install Python 3.10 or newer. From the repository root, optionally install `pypdf` in your Python environment to enable the PDF fallback.

   ~~~sh
   python -m pip install -r bridge/requirements.txt
   ~~~

2. Start a local inference service that supports OpenAI-compatible Chat Completions and JSON object output. For example, download a local model such as `gemma3:4b` in Ollama. With the model downloaded, configure the **Ollama service** with `OLLAMA_NO_CLOUD=1` and restart it to keep inference on your hardware. An example invocation for a manually managed Ollama service follows. Its context window must fit the prompt, source excerpts and output allowance. [Ollama local settings](https://docs.ollama.com/faq) · [Ollama model example](https://ollama.com/library/gemma3)

   ~~~sh
   OLLAMA_NO_CLOUD=1 OLLAMA_CONTEXT_LENGTH=16384 ollama serve
   ~~~

3. In another terminal, set the bridge environment. The following commands use Bash. Keep this terminal private. The printed value is the pairing token that belongs in the userscript's pairing prompt. Reuse the same private token between starts or pair again after rotating it.

   ~~~sh
   export ARXIV_AI_PROVIDER=local
   export ARXIV_AI_MODELS=gemma3:4b
   export ARXIV_AI_MAX_INPUT_CHARS=18000
   export ARXIV_AI_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
   printf '%s\n' "$ARXIV_AI_TOKEN"
   python bridge/server.py
   ~~~

4. Open the Discovery AI settings on arXiv. Select the local provider, enter the same model name, and use `http://127.0.0.1:4317` for the bridge. Pair using the token, review the data-transmission disclosure and enable on-demand generation. Click **AI Overview** or request a definition. The model's readiness, context capacity and speed depend on the inference service. A first model load may take longer than subsequent calls.

The local provider uses `http://127.0.0.1:11434/v1/chat/completions`. An OpenAI-compatible server on another local port can be selected with `ARXIV_AI_LOCAL_PORT`. The local service operator controls what happens after a request reaches that endpoint. Choose locally installed weights and disable any cloud forwarding to keep the prompt on the computer. [Ollama compatibility reference](https://docs.ollama.com/api/openai-compatibility)

### Windows PowerShell

Open PowerShell in the repository folder. If you manage Ollama from a terminal, set `$env:OLLAMA_NO_CLOUD = '1'` and `$env:OLLAMA_CONTEXT_LENGTH = '16384'` in that terminal before starting `ollama serve`. A running desktop Ollama service must be restarted with its intended configuration. In a separate PowerShell window, start the bridge with the name of the model you have downloaded.

~~~powershell
$env:ARXIV_AI_PROVIDER = 'local'
$env:ARXIV_AI_MODELS = 'gemma3:4b'
$env:ARXIV_AI_MAX_INPUT_CHARS = '18000'
$env:ARXIV_AI_TOKEN = (python -c "import secrets; print(secrets.token_urlsafe(32))")
Write-Output $env:ARXIV_AI_TOKEN
python bridge/server.py
~~~

Copy the printed pairing token into **Settings → Pair / replace bridge token** and complete step 4 above. Keep the bridge terminal open while requesting explanations. If the installation provides the Windows Python launcher, `py -3` can replace `python` in these commands.

## Hosted OpenAI setup

Use an OpenAI API project with access to a Chat Completions model supporting system instructions, JSON object mode and `max_completion_tokens`. API access and usage depend on the API organization and its billing settings. Enter the current standard input and output rates in USD per million tokens. For multiple allowed models, use the highest applicable rate in each direction. [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [Current API prices](https://developers.openai.com/api/docs/pricing) · [API billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)

Use the same pairing-token setup as above. In the **bridge terminal**, set the following values, then start the bridge. The prompts below accept credentials and configuration without hardcoding example secrets or price assumptions. In the userscript select **OpenAI** and the exact model name, review the disclosure, and enable generation.

~~~bash
export ARXIV_AI_PROVIDER=openai
read -rp 'Allowed model name: ' ARXIV_AI_MODELS
read -rsp 'OpenAI API key: ' OPENAI_API_KEY
printf '\n'
read -rp 'Input USD per million tokens: ' ARXIV_AI_INPUT_USD_PER_MILLION
read -rp 'Output USD per million tokens: ' ARXIV_AI_OUTPUT_USD_PER_MILLION
export ARXIV_AI_MODELS OPENAI_API_KEY ARXIV_AI_INPUT_USD_PER_MILLION ARXIV_AI_OUTPUT_USD_PER_MILLION
export ARXIV_AI_DAILY_USD=1
python bridge/server.py
~~~

In Windows PowerShell, use the same generated pairing token and enter the hosted API credential at the masked prompt. Supply current rates for the model before starting the bridge.

~~~powershell
$env:ARXIV_AI_PROVIDER = 'openai'
$env:ARXIV_AI_MODELS = Read-Host 'Allowed model name'
$secret = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
$env:ARXIV_AI_INPUT_USD_PER_MILLION = Read-Host 'Input USD per million tokens'
$env:ARXIV_AI_OUTPUT_USD_PER_MILLION = Read-Host 'Output USD per million tokens'
$env:ARXIV_AI_DAILY_USD = '1'
python bridge/server.py
~~~

Hosted requests use the fixed HTTPS endpoint at `api.openai.com/v1/chat/completions` and set `store: false`. The provider's account and data-handling policies still apply. The API credential belongs exclusively in the bridge process environment. Paste only the separate **pairing token** into the userscript. A provider or model mismatch stops the request before paper retrieval or inference.

## Hosted Gemini setup

The bridge also supports the Gemini API's OpenAI-compatible endpoint. Choose a model available to your Google AI Studio project and check the current [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) and provider terms. Google may use free-tier prompts and responses to improve its products. Hosted usage is subject to your provider's limits and billing settings.

For example, in PowerShell in the repository folder, generate a separate pairing token and enter the provider key at a masked prompt. Supply positive per-million-token rates for the bridge's conservative cost estimates, even when using a free tier. Keep the terminal open while requesting explanations.

~~~powershell
$env:ARXIV_AI_PROVIDER = 'gemini'
$env:ARXIV_AI_MODELS = Read-Host 'Allowed Gemini model name'
$env:ARXIV_AI_TOKEN = (python -c "import secrets; print(secrets.token_urlsafe(32))")
Write-Output $env:ARXIV_AI_TOKEN
$secret = Read-Host 'Gemini API key' -AsSecureString
$env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
$env:ARXIV_AI_INPUT_USD_PER_MILLION = Read-Host 'Input USD per million tokens (estimate)'
$env:ARXIV_AI_OUTPUT_USD_PER_MILLION = Read-Host 'Output USD per million tokens (estimate)'
$env:ARXIV_AI_DAILY_USD = '1'
python bridge/server.py
~~~

In **Settings**, select **Google Gemini API**, enter the same model name, pair using the printed pairing token—not the Gemini API key—and enable AI after reviewing the disclosure. The bridge sends requests to `generativelanguage.googleapis.com`; it does not store the API key in browser settings. The included bridge does not automatically read a `.env` file.

## What leaves the browser

| Destination | Data |
| --- | --- |
| Paired bridge on this computer | arXiv ID and version, title, original abstract, listing date if known, selected operation, term, follow-up question and optional surrounding reading context, up to 64 editable knowledge topics and levels, spoiler policy, configuration limits, model name |
| arXiv | HTTPS requests for the selected public paper's canonical HTML and, when needed, PDF. The bridge strips browser cookies and spaces its downloads at least 15 seconds apart with one active arXiv connection. A backoff response pauses further downloads. |
| Selected model | Title, arXiv identifier, labeled source excerpts, selected term or question, optional surrounding sentence or earlier-answer excerpt, knowledge topics and levels, requested response fields, and reading instructions |
| Local usage database | UTC day, number of provider attempts, and charged or reserved estimated microdollars |

The request builder has an explicit field allowlist. Feedback, interest estimates, subscriptions, reading history, bookmarks, the complete glossary and the pairing token stay out of model prompts. With more than 64 knowledge topics, names present in the paper or reader's input receive priority. Model calls occur on reader requests. Loading a listing creates no provider traffic.

## Source selection and citations

1. The bridge requests the matching `https://arxiv.org/html/<id-and-version>` and extracts the article body. It retains actual HTML section or theorem anchors, prefers available TeX alternatives for math and ignores scripts, navigation and hidden content.
2. If HTML is unavailable or unusable, the bridge tries the matching PDF when `pypdf` is installed. A short-lived worker reads the text of each page under a timeout and available OS resource limits. It rejects encrypted, image-only, oversized, evidently garbled or unmapped mathematical-font pages. It does not perform OCR. A densely symbolic page can fail these conservative checks. Even a legible extraction can lose superscripts, alignment or character order. Links open the original PDF at the corresponding page. [pypdf extraction guide](https://pypdf.readthedocs.io/en/stable/user/extract-text.html)
3. A failed full-text attempt falls back to the page's original abstract and identifies the reason. With no usable source, the bridge stops before calling the provider.

For a long source, the bridge selects passages up to the excerpt limit. Dictionary requests favor occurrences of the selected term. Overviews sample across the article. Each answer states the source and how much extracted text was supplied. An unversioned listing points at the current arXiv record and carries an explicit note. Public source text stays in a bounded in-memory cache of up to 24 papers. Positive entries expire after one day for explicit versions and one hour for unversioned IDs. A failed acquisition is cached for five minutes.

The bridge gives the model passage identifiers. A paper-specific response field needs an exact short quotation from one of those passages. The bridge generates citation URLs from the actual paper location. Missing evidence produces a visible unavailable field. A general dictionary definition can still be returned when the paper does not establish a particular use of the term. Generated definitions and illustrative examples carry a general-background label when uncited. A source match verifies the text of a quotation. Readers can inspect the cited section or page to check interpretation, proof status and significance.

## Independent research and follow-ups

The paper-specific setting overrides the global default. Protected mode supplies only selected background material and requests orientation, the question, prerequisites and connections. It omits results and proof fields. It also recognizes explicit proof requests and suppresses identifiable proof disclosures in the generated fields. For a research question whose title already states the answer or for an unusually worded passage, automated filters cannot guarantee spoiler-free wording. Keep the policy enabled for definitions and background, and explicitly change it for a paper before requesting its methods or results.

Definitions support standard, simpler and rigorous explanations, an illustrative example, prerequisite topics, and a source-linked account of the term's use. A follow-up can include a short previous-answer excerpt to clarify a pronoun or a recursively selected term. An earlier generated explanation can supply context for a question. Only quotations from the acquired paper can establish a paper-specific claim.

## Structured Highlights assessments

Open the Highlights feed from a complete Recent population, choose **Assess selected Recent papers**, and select the papers explicitly. The configured batch limit bounds each action. Opening a feed does not trigger analysis. Requests use the existing paired bridge, provider consent, allowance and spending limits, with the full reading profile and the normal HTML/PDF/abstract source fallback. Closing the assessment panel or changing the active view stops further requests in the batch.

The separate `highlight` action returns a decision with `status`, `basis`, `reason` and verified `citations`. Only `candidate` decisions enter Highlights. The allowed bases are `open_problem`, `bound`, `method`, `connection`, `generalization` and `computation`; ordinary topic description is insufficient. The model must identify a potentially notable author-claimed contribution under its stated hypotheses. It must not infer significance from authors, institutions or reputation. A candidate remains an **unverified AI assessment**: quotation matching does not independently establish proof validity, novelty, historical priority or importance.

The bridge checks each proposed quotation against the actual supplied passage and creates its citation URL from that source. Missing or fabricated evidence, unsupported basis values, or an absent decision produce `not_established`. Inconclusive assessments remain separate from candidates. The browser validates the decision, requires citation URLs for the same paper and version, and checks that its quotations belong to the verified source-citation set. A generic overview or legacy cache entry cannot substitute for this decision.

With **No Spoilers** active, the bridge returns a fixed `not_established` explanation before retrieving source text or calling a model. The existing consent and allowance checks still apply, and no provider attempt is charged for this protected response. The browser suppresses generated result prose and quotations for protected Highlight requests. Stored assessments are checked against the current paper version, protection setting and unknown-version expiry; changing protection hides incompatible candidates. Ordinary overview and dictionary behavior is unchanged.

## Limits and cost

| Bridge environment variable | Default | Meaning |
| --- | --- | --- |
| `ARXIV_AI_PROVIDER` | `local` | `local`, `openai` or the retained upstream `gemini` adapter. Must match browser consent. |
| `ARXIV_AI_MODELS` | Required | Comma-separated model allowlist. The browser requests one exact model. |
| `ARXIV_AI_TOKEN` | Required | Random URL-safe pairing token of 32–256 characters. |
| `OPENAI_API_KEY` | Required for OpenAI | Provider credential read only by the OpenAI bridge configuration. |
| `GEMINI_API_KEY` | Required for Gemini | Provider credential read only by the retained upstream Gemini configuration. |
| `ARXIV_AI_PORT` | `4317` | Bridge port on literal IPv4 loopback. |
| `ARXIV_AI_LOCAL_PORT` | `11434` | Local model service port on literal IPv4 loopback. |
| `ARXIV_AI_MAX_INPUT_CHARS` | `100000` | Maximum source text characters per request, 256–120000. The system prompt and reader context also consume tokens. |
| `ARXIV_AI_MAX_OUTPUT_TOKENS` | `1600` | Maximum completion tokens per request, 64–8192. |
| `ARXIV_AI_DAILY_REQUESTS` | `10` | Combined UTC-day provider attempts, 0–10000. |
| `ARXIV_AI_DAILY_USD` | `1` | Maximum estimated daily charges across all clients of the ledger, 0–10000 USD. |
| `ARXIV_AI_INPUT_USD_PER_MILLION` / `ARXIV_AI_OUTPUT_USD_PER_MILLION` | `0` for local | Positive values required for hosted. The effective rates are the greater of server and browser rates. |
| `ARXIV_AI_USAGE_DB` | `~/.arxiv-discovery/usage.sqlite3` | Persistent aggregate daily usage database. |

Browser limits can further lower the bridge's count, budget, excerpt and output caps. Before a provider call, one SQLite transaction reserves one request and the estimated maximum charge. The bound uses the UTF-8 byte length of the serialized messages plus 1,024 tokens of margin, and the entire output allowance. The model might split mathematical notation and non-ASCII text very differently from ordinary English. A short excerpt can therefore make a substantial difference in whether a tight budget permits the request.

When the provider reports actual token counts, the bridge settles the reservation at the configured prices. Failed or interrupted provider attempts still consume a request. Missing usage retains the conservative cost reservation. The browser never automatically retries a failed generation. Local limits use the prices you supply, so compare them with the provider's current rates and account-level controls when real charges matter. Cached answers require no provider call.

The browser cache key includes the source record, version and known announcement date, provider, bridge origin, model, protection policy, knowledge topics, task, term, context, follow-up, detail, model limits and prompt version. Unversioned answers refresh after an hour. Abstract fallbacks for explicit versions refresh after one day. To remove bridge-side information, stop the bridge to clear its in-memory source cache. The aggregate ledger file can be removed from its configured path after stopping the bridge. Deleting it also resets daily enforcement. Changing the pairing token and restarting revokes the old token.

## Transport and validation

The bridge binds only `127.0.0.1`, validates the Host and supported caller Origin, requires an exact secret bearer token with constant-time comparison, and emits no cross-origin access grants. The privileged userscript transport sends plain JSON to that literal loopback origin. Paper IDs, model names, inputs and sizes are validated. The source fetcher constructs URLs from a validated ID and only accepts a narrowly matched arXiv redirect for the same paper. Provider redirects are never followed. Provider destinations come from the operator's fixed backend selection. Paper or reader text cannot select a destination, run a program or invoke tools.

The HTTP transport has separate per-call output limits and timeouts. A local process with access to your browser profile, terminal or environment may also be able to read the pairing secret. Generated mathematical prose can still be wrong even when it quotes a real passage. The interface returns an explicit error if an overview supplies no verifiable paper-specific field, the provider refuses or times out, or the response exceeds its allowed output.

## Offline validation

From the repository root run the following commands. The bridge suite uses a real loopback HTTP server, an injected fixture arXiv fetcher and a local test-model responder. Hosted request shapes are checked without contacting OpenAI or Gemini. With `pypdf` installed, the suite also starts the real isolated PDF worker.

~~~sh
node --test tests/ai.test.js
python -m unittest discover -s tests -p test_bridge.py -v
~~~

Validated against the official [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [pypdf extraction documentation](https://pypdf.readthedocs.io/en/stable/user/extract-text.html), [arXiv web crawler rules](https://arxiv.org/robots.txt) and [arXiv access guidance](https://info.arxiv.org/help/api/tou.html) on 2026-11-26. Network availability, access permissions and mathematical answer quality depend on the chosen live services.


## Local reading profiles and response progress

The Local reading profile defaults to **Quick** in new and existing browser settings. For ordinary unprotected overviews this uses the original listing abstract without downloading the paper. The source label explicitly identifies abstract-only analysis. Quick limits source excerpts to 4,000 characters, generated output to 768 tokens (including JSON and quotations), and uses a shorter set of answer fields. Existing configured limits may be lower. Protected readings retain the background filter; term explanations still retrieve relevant paper excerpts. Select **Detailed** or use **Detailed paper overview** for the original HTML/PDF-first behavior. Rigorous explanations and follow-ups use Detailed by default. Hosted OpenAI retains the full profile.

The bridge still requires exact source quotations for paper-specific claims. The local prompt now emphasizes preserving quantifiers, hypotheses, inequalities, exponents, and minimum/maximum distinctions. These instructions and quotation matching do not certify the model's interpretation.

Local requests may stream OpenAI-compatible provider events. The browser receives only progress metadata until the complete structured answer passes existing source validation; it never displays or caches unchecked partial prose. If the provider returns a complete JSON response instead, the bridge accepts that response normally. No automatic retry is made. An older bridge may ignore the new request fields; update both components to obtain the new behavior.

The bridge accepts `ARXIV_AI_PROVIDER_TIMEOUT_SECONDS` (30–300 seconds; default 180 for local and 100 for hosted). This sets the provider socket timeout and the local stream deadline. The browser request timeout is independently configurable in AI Settings (60–600 seconds, default 420); allow time for source retrieval as well as generation. Browser/transport buffering may delay live progress notifications. Actual speed and model compatibility must be tested on the reader's computer.
