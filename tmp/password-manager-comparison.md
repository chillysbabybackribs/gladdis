| Vendor | Annual price | Local-vs-cloud model | Recent incidents | Agrees-with-review? |
| --- | --- | --- | --- | --- |
| 1Password | `1Password Families`: `$53.88/year` from the live pricing page's `$4.49/month` "Paid annually" rate. | 1Password says the account password is never stored alongside your 1Password data or transmitted over the network, and the account's data is protected by a Secret Key combined with that password; the service stores end-to-end encrypted account data server-side while the unlock secret stays with the user/device. | No material incidents found as of `2026-07-01`; search results in the last 12 months surfaced phishing against users and a vendor statement that a recent notification incident was not a breach. | `No`: Tom's Guide lists `1Password Families` at `$4.99/mth` (`$59.88/year`), higher than the current live page. |
| Bitwarden | `Bitwarden Families`: `$47.88/year` directly listed on the live pricing page. | Bitwarden says it encrypts and/or hashes data on the local device before anything is sent to cloud servers, that servers are only used for storing encrypted data, and that locally stored data is decrypted only when the vault is unlocked. | Material incidents found: `CVE-2025-5138` was reported in May 2025 as an XSS issue in Bitwarden's PDF file handler, and OpenCVE also lists the compromised `@bitwarden/cli@2026.4.0` npm package from April 2026. | `No`: Tom's Guide says Bitwarden's family plan is `$40/year` for up to six people, below the current live page. |
| Dashlane | `Friends & Family`: `$97.56/year` from the live personal pricing page's `$8.13/month for 10 members` "Billed annually" rate. | Dashlane says only the user can access vault data, that logins and personal information stay encrypted even when stored on Dashlane servers for backup and sync, and that data is decrypted on the device only after the user enters the Master Password. | Material incident found: Dashlane disclosed a brute-force attack against user accounts on `2026-06-01`; its advisory says some accounts were targeted and suspended, with the investigation later stating there was no additional impact to Dashlane systems. | `Not listed`: the Tom's Guide 2026 comparison page mentions Dashlane in feature discussion but does not provide a current Dashlane plan price to compare. |

## Improvement opportunity for VaultStore

`VaultStore` should eliminate the current `raw:` base64 fallback and require a real encrypted vault format even when Electron `safeStorage` is unavailable. A concrete follow-up would be:

1. Generate a random per-installation vault key on first use.
2. Protect that vault key with a user secret plus device protection instead of writing recoverable plaintext-equivalent data.
3. Encrypt every stored entry with AEAD using that vault key.
4. Refuse persistence until the vault key can be protected safely, rather than silently falling back to `raw:`.

This is most directly inspired by `1Password`'s documented model where the account password is never stored alongside the account data and the data is protected by a separate `Secret Key` combined with that password.
