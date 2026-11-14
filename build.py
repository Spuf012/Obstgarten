"""Baut index.html (Web-Version) aus der App-Datei obstgarten.html.
Aufruf: python3 build.py src/obstgarten.html"""
import sys, re, pathlib
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "src/obstgarten.html").read_text()
title_m = re.search(r"<title>.*?</title>\s*", src)
src = src.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
src = re.sub(r"<title>.*?</title>\s*", "", src, count=1)
# Externe Schriften/Stile (link-Tags) in den Head verschieben
links = re.findall(r'<link [^>]+>\s*', src)
for l in links: src = src.replace(l, "", 1)
src = src.replace('<meta name="apple-mobile-web-app-capable" content="yes">\n', '')
GATE_CSS = """<style>
:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);color-scheme:light}
body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
img{max-width:100%}
[hidden]{display:none!important}
#gate{position:fixed;inset:0;z-index:100;background:var(--bg);display:grid;place-items:center;overflow:auto;padding:max(24px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px))}
.gatecard{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px;display:flex;flex-direction:column;gap:12px;text-align:center}
.gatecard h1{font-family:var(--display);margin:0;font-size:1.6rem}
.gatecard p{margin:0}
.gatecard .form{text-align:left}
.gatelogo{display:grid;place-items:center}
.gatelogo svg{width:72px;height:72px}
</style>"""
head = f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Obstgarten">
<meta name="theme-color" content="#edf1ea" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1511" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" type="image/png" href="icon-192.png">
{title_m.group(0).strip() if title_m else "<title>Obstgarten</title>"}
{"".join(links).strip()}
{GATE_CSS}
</head>
<body>
"""
gate = """<div id="gate" hidden></div>
<template id="gateLogo"><svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#2f6b3a"/><path d="M32 52V32" stroke="#f3efe2" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="24" r="14" fill="#7fc489"/><circle cx="26" cy="22" r="3.5" fill="#c0353a"/><circle cx="37" cy="27" r="3.5" fill="#c0353a"/><circle cx="35" cy="17" r="3" fill="#c0353a"/></svg></template>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
<script src="host.js"></script>
"""
# Gate + Host-Skripte vor das App-Skript setzen
i = src.index("<script>")
out = head + src[:i] + gate + src[i:] + "\n</body>\n</html>\n"
pathlib.Path("index.html").write_text(out)
print("index.html", len(out))
