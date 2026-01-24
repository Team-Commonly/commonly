# WhatsApp Cloud API Notes

This is a brief summary of the official WhatsApp Cloud API documentation used for planning.

## Webhook Verification (GET)
When configuring webhooks, Meta sends a GET request to your callback URL with:
- `hub.mode=subscribe`
- `hub.verify_token=<token>`
- `hub.challenge=<random>`

Your endpoint should compare `hub.verify_token` to your configured verify token and respond with `hub.challenge` if it matches.

## Incoming Message Webhook (POST)
Webhook payloads include:
- `object: "whatsapp_business_account"`
- `entry[] -> changes[] -> value.messages[]`
- Each `messages[]` item includes `from`, `id`, `timestamp`, `type`, and `text.body` for text messages.

## Send Message (POST)
To send messages, call:

`POST /<PHONE_NUMBER_ID>/messages`

With a JSON body including:
- `messaging_product: "whatsapp"`
- `recipient_type: "individual"`
- `to: <recipient phone number>`
- `type: "text"`
- `text.body: <message>`

## Key IDs
- **WABA ID**: WhatsApp Business Account ID
- **Phone Number ID**: required for sending messages

## Notes
- Contextual replies can include a `context.message_id` to reference an incoming message.
- Webhook payloads include `metadata.phone_number_id` for routing.
