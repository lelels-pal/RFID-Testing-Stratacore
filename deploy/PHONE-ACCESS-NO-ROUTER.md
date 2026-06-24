# Phone access WITHOUT changing router settings

For **large company / shared Wi‑Fi** deployments: do **not** change router DHCP DNS.
That can affect every device on the network. Use one of these instead.

---

## Option A — Manual DNS on your phone only (testing / small team)

Only **your phone** uses the Stratacore PC as DNS. The company router and all other users are unchanged.

**Requirements on the Stratacore PC:**
1. Docker Desktop running (dnsmasq)
2. `SETUP-DNSMASQ.bat` or `SETUP-LAN-ACCESS.bat` already run
3. `START-STRATACORE.bat` running

**Your PC LAN IP:** `192.168.254.154` (check with `ipconfig` if it changes)

### iPhone / iPad

1. Settings → **Wi‑Fi**
2. Tap **(i)** next to your company Wi‑Fi network
3. Scroll to **DNS** → **Configure DNS** → **Manual**
4. Remove existing servers (optional) → **Add Server** → `192.168.254.154`
5. Save, then open Safari: `https://admin.stratacore.tech`
6. Accept the self-signed certificate once

To revert: set DNS back to **Automatic**.

### Android

1. Settings → **Network & Internet** → **Wi‑Fi**
2. Long-press your network → **Modify** / **Manage network**
3. **Advanced** → **IP settings** → **Static** (or stay DHCP with **Private DNS** off)
4. Set **DNS 1** to `192.168.254.154`
5. Save, open Chrome: `https://admin.stratacore.tech`

*(Steps vary slightly by manufacturer.)*

### What this does

```text
Your phone only  →  DNS 192.168.254.154  →  dnsmasq  →  admin.stratacore.tech
Everyone else    →  unchanged (company DNS)
Router           →  not touched
```

---

## Option B — Corporate IT internal DNS (recommended for production)

For a **large company**, the standard approach is a **one-time IT ticket** — not router changes.

Ask company IT to add **internal DNS A records** on the **corporate DNS server** (Active Directory, Infoblox, etc.):

| Hostname | Points to |
|----------|-----------|
| `admin.stratacore.tech` | Stratacore server LAN IP |
| `api.stratacore.tech` | same IP |
| `guest.stratacore.tech` | same IP |
| `ocpp.stratacore.tech` | same IP |

**Example ticket text:**

> Please add internal DNS A records for our on-prem EV charging kiosk (LAN-only, no public internet):
>
> - admin.stratacore.tech → 192.168.x.x  
> - api.stratacore.tech → 192.168.x.x  
> - guest.stratacore.tech → 192.168.x.x  
> - ocpp.stratacore.tech → 192.168.x.x  
>
> No router or DHCP changes required. No port forwarding. Traffic stays on the local VLAN.

Phones and chargers already use company DNS — they will resolve `stratacore.tech` automatically. **No per-phone setup.**

On **Xubuntu production**, you do **not** need dnsmasq if IT adds these records. Run Stratacore + Caddy only.

---

## Option C — MDM profile (if IT manages phones)

If the company uses **Intune / Jamf / MDM**, IT can push a Wi‑Fi or DNS profile for a **dedicated charging-staff SSID or VLAN** without changing the main office router DHCP for everyone.

---

## What NOT to do (shared company network)

| Avoid | Why |
|-------|-----|
| Change router DHCP DNS | Affects all Wi‑Fi clients; can break internet if Stratacore PC is off |
| Public GoDaddy DNS to home IP | Exposes system to internet |
| Port forwarding | Same |

---

## Verify from your phone

After Option A (manual DNS) or Option B (IT records):

1. Open `https://admin.stratacore.tech`
2. Accept certificate warning once
3. Log in: `admin` / `admin123`

If the page does not load, DNS is not reaching Stratacore yet — run `VERIFY-LAN-ACCESS.bat` on the PC.

---

## Windows dev PC vs Xubuntu production

| Environment | Phone access method |
|-------------|---------------------|
| **Windows dev (now)** | Option A — manual DNS on your phone → PC `192.168.254.154` |
| **Large company (production)** | Option B — IT internal DNS records → Xubuntu server IP |
| **Dedicated site with own router** | Optional dnsmasq + router DNS (see XUBUNTU.md) — only when you control the router |
