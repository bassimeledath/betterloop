# Group covers and newsletter photos

Group owners and administrators can open **Schedule & preferences → Your group cover** to upload a JPEG, PNG or WebP, adjust zoom and crop position, add a description, save, edit, replace or remove the current cover. The cover appears on the group card, group page, web letter and newsletter email. Choose a replacement file to reframe from the original; editing the saved crop allows further cropping and description changes.

A publication snapshots its cover identity and description. Later cover changes affect future letters, while published letters retain their cover. Previously delivered email copies cannot be recalled. Replaced covers that no publication references are cleaned after seven days. Removing a group also removes its covers through the group lifecycle.

Submission photos are resized on the device. Their original prepared JPEG stays in private R2 storage. A smaller email copy, up to 800 pixels and 96 KiB, is stored with the asset. Cover JPEGs are capped at 192 KiB and stored in D1. These bounded image records are included in encrypted D1 backups; no additional public bucket is created. Image metadata is stripped on the server as well as through browser preparation.

Emails carry images as **CID inline attachments**. They do not use public URLs or permanent bearer links. The web photo endpoints continue requiring group membership; another member cannot read an unpublished contribution's photo. Delivered email images can be saved or forwarded, just like the text.

The email builder stays below 32 attachments and 12 MiB of raw image bytes, leaving room for MIME encoding and text within the provider message limit. Cover images take priority, then contribution photos in newsletter order. Any remaining photos retain their captions and a link to the private web letter. Older uploads without compact copies use the original prepared JPEG when it fits. The same selection is used by the preview. These bounds follow the [Cloudflare email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

Use **Preview newsletter email** in group settings, or after saving and reviewing your update. Before publication it shows only your own saved draft, clearly marked as a draft to submit; it never gives the host early access to other members' answers. After publication the preview uses the published snapshot. Scripts and forms are disabled in the preview; only same-origin authenticated image requests are permitted. A full-page preview link is available for checking mobile layout.

The current cover and each published cover are included as bounded JSON source files in group exports. Backups include the cover and email-copy BLOBs. The restore writer breaks large BLOB writes into small SQL statements; byte preservation was checked locally and in a temporary actual Cloudflare D1 database that was deleted afterward.

Verification includes crop/upload/replacement/removal in a 390-pixel browser, caption escaping, inline attachment identities and bytes, private preview and asset access, immutable published covers, message size/count limits, export/lifecycle regressions and BLOB recovery. The repository CI runs backend and browser coverage. Screenshots use synthetic people and photos: [mobile email](evidence/mobile-photo-email.png), [cover controls](evidence/mobile-cover-controls.png).

Email clients may differ in presentation. Browser preview and provider-payload tests do not establish rendering in every Gmail or Apple Mail version. No test newsletter was sent to friends and no paid plan was enabled.
