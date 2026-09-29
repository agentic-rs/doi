# AI setup

Papertrail embeds [Tokn](https://github.com/tokn-ai/tokn)'s Rust provider components on desktop and iOS. Bring your own API key for OpenAI, DeepSeek, Z.ai, or Zhipu, including the Z.ai and Zhipu Coding Plan endpoints. Choose **OpenAI-compatible** for a custom chat-completions service; a local service can work without a key.

1. Open AI settings from the reading overlay.
2. Choose a provider. Papertrail fills its default API base URL; change it if your account uses a different compatible endpoint.
3. Enter your provider's API key. Leave the field blank to retain a saved key for the same endpoint.
4. Choose **Load models**, then select a model. If discovery is unavailable or your model is not listed, enter its ID manually.
5. Save settings. Select a passage and use the sparkle icon to open **Ask AI**.
6. Ask a question and continue with **Ask follow-up**. Choose **Generate note** to distill the conversation, review the draft, then **Save note** to annotate the passage.

Model discovery uses the entered key without saving it. Saving settings stores the key in the native credential store. Switching providers or changing the endpoint clears an unsaved key, and an endpoint never inherits another endpoint's saved key. To remove a saved key, select the removal checkbox and save settings.

Papertrail sends the selected passage, nearby text, paper metadata, and your question to the chosen provider. Follow-ups and note generation also send the completed questions and answers in that conversation. Model discovery requests its model list without sending paper text. Saved AI notes retain the source answer, model, endpoint, question, and supplied context in the annotation sidecar.

The app does not require a Tokn gateway or a separate Tokn configuration. Cloud providers work directly from each device. A custom network endpoint must use HTTPS; HTTP is accepted for loopback endpoints. On iPhone, localhost refers to the phone itself.

## Asking and saving

**Ask** streams the response into a draft. When the provider returns thinking text, it appears in an expandable **Thinking** section, separate from the answer. Providers that do not expose thinking still show request activity. **Stop** cancels the request and leaves received text visible as an incomplete answer.

For the first answer, the model can call `propose_annotation` to suggest a concise note. This tool prepares content for review; it never writes annotations. If the first answer has no proposal, you can edit and save the answer instead.

Use **Ask follow-up** to continue in the same conversation. Follow-ups produce answers without requesting new notes. **Generate note** explicitly asks the model to choose the useful takeaways from the completed conversation through `propose_annotation`. Review and edit that draft before choosing **Save note**. If the model cannot provide a valid tool proposal, the app shows an error and retains the previous draft. Saving does not request another model response, and a failed save retains the draft for retry.

Conversations and note drafts persist locally, separately from annotations, and reopen with the same paper revision and original selected passage. Collapsing a conversation keeps its history. Interrupted answers are marked incomplete and excluded from future model context. Thinking is visible during the session but is not persisted or exported. Annotation exports include saved notes and their source answers; unsaved conversations and drafts are not exported. A note generated from a conversation retains the completed questions and answers it was based on.

Further answers do not change a saved annotation or silently regenerate a draft. A draft based on earlier answers is labelled accordingly; generate a new draft to include later answers. Saving a new generated draft creates a new annotation. Saved notes display the reviewed text and retain their source answer for reference. Older annotations without a separate note continue to display their original answer.

## Connection troubleshooting

Papertrail honors proxy environment variables. On desktop, a proxy using a private certificate authority can provide a PEM certificate bundle through `SSL_CERT_FILE`, or `CURL_CA_BUNDLE` when the former is unset or empty. Papertrail loads this bundle when it starts and adds its certificates to Papertrail's trust configuration alongside the operating system's trusted roots. Certificate and hostname verification remain enabled. Restart Papertrail after changing this configuration.

Connection errors distinguish certificate verification, secure-connection, DNS, refused-connection, and timeout failures. Model discovery identifies its own failures. An unreadable or invalid configured certificate bundle prevents network requests but leaves the local library available. A manually entered model ID bypasses model discovery; it cannot fix a connection failure affecting AI answers.

## Implementation

Tokn's provider crates are pinned to upstream revision `4db3eedb869604b460980956ad42152daaa23ad1`. Papertrail constructs a request-scoped account using a key read from Keychain, then uses Tokn's provider request, credential, and input-transformation APIs. Model discovery uses the same provider headers with a bounded response reader. The custom compatible option uses Tokn's llama.cpp chat adapter with the configured endpoint and optional key.

The full gateway and file-backed SDK client are not started. App settings remain in Papertrail's database, credentials remain in Keychain, and existing endpoint/model settings deserialize as a custom compatible provider. No Tokn auth file or request archive is created by this integration. Tokn may read an existing cache of public model metadata when constructing a provider.

Answers use a bounded streaming parser with buffered-response compatibility. Conversation history uses structured user/assistant messages; total context is bounded and oversized requests fail without silently discarding earlier turns. Tool arguments are validated before becoming a draft, and tool follow-ups are bounded. Explicit note generation disables DeepSeek thinking to support its required tool-call mode without storing reasoning history. OAuth account setup and direct Anthropic BYOK are not part of this integration.
