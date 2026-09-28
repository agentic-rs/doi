# AI setup

Papertrail embeds [Tokn](https://github.com/tokn-ai/tokn)'s Rust provider components on desktop and iOS. Bring your own API key for OpenAI, DeepSeek, Z.ai, or Zhipu, including the Z.ai and Zhipu Coding Plan endpoints. Choose **OpenAI-compatible** for a custom chat-completions service; a local service can work without a key.

1. Open AI settings from the reading overlay.
2. Choose a provider. Papertrail fills its default API base URL; change it if your account uses a different compatible endpoint.
3. Enter your provider's API key. Leave the field blank to retain a saved key for the same endpoint.
4. Choose **Load models**, then select a model. If discovery is unavailable or your model is not listed, enter its ID manually.
5. Save settings. Select a passage and use the sparkle icon to open **Ask AI**.
6. Ask a question, review the answer and suggested note, then choose **Save note** when you want to keep it.

Model discovery uses the entered key without saving it. Saving settings stores the key in the native credential store. Switching providers or changing the endpoint clears an unsaved key, and an endpoint never inherits another endpoint's saved key. To remove a saved key, select the removal checkbox and save settings.

Papertrail sends the selected passage, nearby text, paper metadata, and your question to the chosen provider. Model discovery requests its model list without sending paper text. Saved AI notes retain the original answer, model, endpoint, question, and supplied context in the annotation sidecar.

The app does not require a Tokn gateway or a separate Tokn configuration. Cloud providers work directly from each device. A custom network endpoint must use HTTPS; HTTP is accepted for loopback endpoints. On iPhone, localhost refers to the phone itself.

## Asking and saving

**Ask** streams the response into a draft. When the provider returns thinking text, it appears in an expandable **Thinking** section, separate from the answer. Providers that do not expose thinking still show request activity. **Stop** cancels the request and leaves received text visible as an incomplete answer.

The model can call `propose_annotation` to suggest a concise note. This tool prepares content for review; it never writes annotations. Edit the suggested note before choosing **Save note**. If the model does not propose a note, you can edit and save the full answer instead. Saving does not request another model response. A failed save retains the draft for retry.

Drafts stay tied to the paper revision and passage selected when asking, even when you navigate to another paper. They remain available during the current app session; only an explicit save writes an annotation. Saved notes display the reviewed text and retain the complete answer for reference. Thinking text is not included in saved annotations or exports. Older annotations without a separate note continue to display their original answer.

## Connection troubleshooting

Papertrail honors proxy environment variables. On desktop, a proxy using a private certificate authority can provide a PEM certificate bundle through `SSL_CERT_FILE`, or `CURL_CA_BUNDLE` when the former is unset or empty. Papertrail loads this bundle when it starts and adds its certificates to Papertrail's trust configuration alongside the operating system's trusted roots. Certificate and hostname verification remain enabled. Restart Papertrail after changing this configuration.

Connection errors distinguish certificate verification, secure-connection, DNS, refused-connection, and timeout failures. Model discovery identifies its own failures. An unreadable or invalid configured certificate bundle prevents network requests but leaves the local library available. A manually entered model ID bypasses model discovery; it cannot fix a connection failure affecting AI answers.

## Implementation

Tokn's provider crates are pinned to upstream revision `4db3eedb869604b460980956ad42152daaa23ad1`. Papertrail constructs a request-scoped account using a key read from Keychain, then uses Tokn's provider request, credential, and input-transformation APIs. Model discovery uses the same provider headers with a bounded response reader. The custom compatible option uses Tokn's llama.cpp chat adapter with the configured endpoint and optional key.

The full gateway and file-backed SDK client are not started. App settings remain in Papertrail's database, credentials remain in Keychain, and existing endpoint/model settings deserialize as a custom compatible provider. No Tokn auth file or request archive is created by this integration. Tokn may read an existing cache of public model metadata when constructing a provider.

Answers use a bounded streaming parser with buffered-response compatibility. Tool arguments are validated before becoming a draft, and tool follow-ups are bounded. OAuth account setup and direct Anthropic BYOK are not part of this integration.
