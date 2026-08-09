import os, re

OUT = "/Users/mathias/Documents/coding/clarvis/media"

# ---------------------------------------------------------------- avatar SVG
def avatar(state):
    """Minimal butler head in a given expression. Geometry cribbed from avatar.html."""
    if state == "thinking":
        lid, browL, browR = 68, "translateY(-4px)", "translateY(-2px)"
        pupil_dx, pupil_dy = -8, -3
        mouth = '<path d="M88 117 q12 2 24 -2" stroke="#34e6f2" stroke-width="4.5" stroke-linecap="round" fill="none" style="filter:drop-shadow(0 0 5px rgba(52,230,242,.5))"/>'
        extra = ('<g fill="#34e6f2"><circle cx="92" cy="126" r="2.6" opacity=".3"/>'
                 '<circle cx="100" cy="130" r="2.6"/><circle cx="108" cy="126" r="2.6" opacity=".6"/></g>')
    else:  # talking
        lid, browL, browR = 62, "translateY(-3px)", "translateY(-6px) rotate(-6deg)"
        pupil_dx, pupil_dy = 0, 0
        mouth = ""
        bars = ""
        for x, h in zip([80, 90, 100, 110, 120], [16, 9, 16, 6, 12]):
            bars += f'<rect x="{x}" y="{116-h/2:.1f}" width="5" height="{h}" rx="2" fill="#34e6f2" style="filter:drop-shadow(0 0 6px rgba(52,230,242,.7))"/>'
        extra = f"<g>{bars}</g>"
    lx, ly = 74 + pupil_dx, 84 + pupil_dy
    rx, ry = 126 + pupil_dx, 84 + pupil_dy
    return f'''
      <rect x="36" y="36" width="128" height="106" rx="34" fill="url(#shell)"/>
      <rect x="36" y="36" width="128" height="106" rx="34" fill="none" stroke="#34e6f2" stroke-opacity=".7" stroke-width="1.6" style="filter:drop-shadow(0 0 3px rgba(52,230,242,.4))"/>
      <rect x="44" y="43" width="112" height="46" rx="24" fill="url(#gloss)"/>
      <path d="M100 36 V22" stroke="#39465b" stroke-width="3.5" stroke-linecap="round"/>
      <circle cx="100" cy="18" r="5" fill="#34e6f2" style="filter:drop-shadow(0 0 8px rgba(52,230,242,.9))"/>
      <rect x="60" y="72" width="28" height="22" rx="11" fill="#080b11"/>
      <rect x="112" y="72" width="28" height="22" rx="11" fill="#080b11"/>
      <g clip-path="url(#eyeL)"><circle cx="{lx}" cy="{ly}" r="7.5" fill="#34e6f2" style="filter:drop-shadow(0 0 7px rgba(52,230,242,.85))"/><circle cx="{lx+2.5}" cy="{ly-2.5}" r="2.4" fill="#eafeff"/></g>
      <g clip-path="url(#eyeR)"><circle cx="{rx}" cy="{ry}" r="7.5" fill="#34e6f2" style="filter:drop-shadow(0 0 7px rgba(52,230,242,.85))"/><circle cx="{rx+2.5}" cy="{ry-2.5}" r="2.4" fill="#eafeff"/></g>
      <g clip-path="url(#eyeL)"><rect x="58" y="{lid}" width="32" height="14" fill="#1b222e"/></g>
      <g clip-path="url(#eyeR)"><rect x="110" y="{lid}" width="32" height="14" fill="#1b222e"/></g>
      <g><circle cx="126" cy="83" r="21" fill="rgba(52,230,242,.05)" stroke="#34e6f2" stroke-opacity=".55" stroke-width="2"/><path d="M143 94 q7 14 1 26" stroke="#1b8a92" stroke-width="1.6" fill="none" opacity=".8"/></g>
      <path d="M62 60 q12 -6 24 -1" stroke="#34e6f2" stroke-width="5" stroke-linecap="round" fill="none" style="filter:drop-shadow(0 0 4px rgba(52,230,242,.55));transform:{browL};transform-origin:74px 60px"/>
      <path d="M114 59 q12 -5 24 1" stroke="#34e6f2" stroke-width="5" stroke-linecap="round" fill="none" style="filter:drop-shadow(0 0 4px rgba(52,230,242,.55));transform:{browR};transform-origin:126px 60px"/>
      {mouth}{extra}
      <path d="M100 152 L78 143 L78 161 Z" fill="url(#tie)"/>
      <path d="M100 152 L122 143 L122 161 Z" fill="url(#tie)"/>
      <circle cx="100" cy="152" r="5.5" fill="#0e1620" stroke="#34e6f2" stroke-opacity=".8" stroke-width="1.6"/>'''

DEFS = '''<defs>
      <linearGradient id="shell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3546"/><stop offset=".55" stop-color="#1a2130"/><stop offset="1" stop-color="#10151f"/></linearGradient>
      <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <linearGradient id="tie" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2ad3e0"/><stop offset="1" stop-color="#127a83"/></linearGradient>
      <clipPath id="eyeL"><rect x="60" y="72" width="28" height="22" rx="11"/></clipPath>
      <clipPath id="eyeR"><rect x="112" y="72" width="28" height="22" rx="11"/></clipPath>
    </defs>'''

CSS = '''
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { width: 1360px; height: 800px; background: #1e1e1e; color: #ccc;
    font: 13px -apple-system, "Segoe UI", sans-serif; display: flex; flex-direction: column; overflow: hidden; }
  .titlebar { height: 30px; background: #323233; display: flex; align-items: center; padding: 0 12px;
    font-size: 12px; color: #999; flex-shrink: 0; border-bottom: 1px solid #000; }
  .dots { display: flex; gap: 6px; margin-right: 14px; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .main { flex: 1; display: flex; min-height: 0; position: relative; }

  .activitybar { width: 48px; background: #333; display: flex; flex-direction: column; align-items: center;
    padding-top: 10px; gap: 22px; flex-shrink: 0; }
  .activitybar .icon { width: 24px; height: 24px; opacity: .55; }
  .activitybar .icon.active { opacity: 1; }
  .activitybar .spacer { flex: 1; }

  .explorer { width: 200px; background: #252526; flex-shrink: 0; padding: 10px 0; }
  .explorer .section-title { font-size: 11px; color: #bbb; letter-spacing: .08em; padding: 4px 20px; font-weight: 600; }
  .explorer .file { padding: 3px 20px 3px 32px; font-size: 13px; color: #ccc; display: flex; align-items: center; gap: 6px; }
  .explorer .file.active { background: #37373d; }
  .explorer .file .badge { margin-left: auto; margin-right: 8px; font-size: 11px; color: #6a9955; }

  .editor { flex: 1; display: flex; flex-direction: column; min-width: 0; background: #1e1e1e; }
  .tabs { display: flex; background: #252526; height: 35px; flex-shrink: 0; }
  .tab { display: flex; align-items: center; gap: 8px; padding: 0 14px; font-size: 13px; color: #969696; border-right: 1px solid #1e1e1e; }
  .tab.active { background: #1e1e1e; color: #fff; border-top: 1px solid #34e6f2; }
  .code { flex: 1; padding: 16px 0 0 0; font: 13px/1.7 "SF Mono", Menlo, monospace; overflow: hidden; }
  .code .line { display: flex; }
  .code .ln { width: 44px; text-align: right; padding-right: 16px; color: #5a5a5a; flex-shrink: 0; }
  .code .src { white-space: pre; }
  .kw { color: #569cd6; } .fn { color: #dcdcaa; } .cm { color: #6a9955; font-style: italic; }
  .num { color: #b5cea8; } .prop { color: #9cdcfe; } .str { color: #ce9178; }
  .del { background: rgba(255,80,80,.13); box-shadow: inset 3px 0 0 #f14c4c; }
  .add { background: rgba(80,220,120,.12); box-shadow: inset 3px 0 0 #4ec97a; }
  .glob { color: #ff6b6b; text-decoration: underline wavy #ff6b6b; text-underline-offset: 3px; }

  .statusbar { height: 24px; background: #34e6f2; display: flex; align-items: center; padding: 0 10px;
    font-size: 12px; color: #062226; font-weight: 600; gap: 16px; flex-shrink: 0; }
  .statusbar .right { margin-left: auto; display: flex; gap: 16px; align-items: center; }
  .statusbar span { display: inline-flex; align-items: center; line-height: 1; }
  .sb-state { min-width: 74px; }

  .clarvis { width: 340px; background: #1a1d24; border-left: 1px solid #000; display: flex;
    flex-direction: column; flex-shrink: 0; min-height: 0; overflow: hidden; }
  .pbody { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .clarvis-header { height: 35px; display: flex; align-items: center; padding: 0 14px; font-size: 11px;
    letter-spacing: .08em; color: #9aa5b3; background: #202430; border-bottom: 1px solid #000; }
  .clarvis-header .branch { margin-left: auto; font-family: "SF Mono", Menlo, monospace; font-size: 10.5px;
    color: #34e6f2; background: rgba(52,230,242,.1); border: 1px solid rgba(52,230,242,.3);
    border-radius: 10px; padding: 1px 8px; letter-spacing: 0; }
  .stage { display: flex; justify-content: center; padding: 10px 16px 4px; }
  .stage svg { width: 92px; height: 92px; }
  .task { padding: 0 16px 10px; text-align: center; }
  .task .label { font-size: 10.5px; color: #6b7787; letter-spacing: .06em; }
  .task .goal { font-size: 13px; color: #dbe4ee; margin-top: 3px; }
  .divider { height: 1px; background: #2a2f3a; margin: 0 14px; }
  .said { margin: 10px 16px 2px; display: flex; gap: 7px; align-items: flex-start;
    font-size: 12px; font-style: italic; color: #8fa0b4; line-height: 1.5; }
  .said .spk { flex-shrink: 0; color: #34e6f2; font-style: normal; opacity: .75; font-size: 11px; padding-top: 1px; }

  .steps { padding: 10px 16px 0; display: flex; flex-direction: column; gap: 6px; }
  .step { display: flex; gap: 8px; font-size: 12px; color: #8b97a6; line-height: 1.45; }
  .step .ic { width: 13px; flex-shrink: 0; text-align: center; }
  .step.done .ic { color: #4ec97a; }
  .step.run .ic { color: #34e6f2; }
  .step code { font-family: "SF Mono", Menlo, monospace; font-size: 11px; color: #aeb8c4; }
  .step.run { color: #cdd6e3; }

  .changed { margin: 12px 16px 0; background: #12151b; border: 1px solid #232838; border-radius: 6px; padding: 9px 11px; }
  .changed .hd { font-size: 10.5px; color: #6b7787; letter-spacing: .06em; margin-bottom: 6px; }
  .changed .row { display: flex; align-items: center; font-size: 12px; color: #9cdcfe;
    font-family: "SF Mono", Menlo, monospace; }
  .changed .row .plus { margin-left: auto; color: #4ec97a; font-size: 11px; }
  .changed .row .minus { color: #f14c4c; font-size: 11px; margin-left: 6px; }

  .gate { margin: 12px 16px 0; background: #2b2415; border: 1px solid #ffb648; border-radius: 8px; padding: 11px 12px; }
  .gate .hd { font-size: 10.5px; color: #ffb648; letter-spacing: .06em; font-weight: 600; margin-bottom: 5px; }
  .gate .cmd { font-family: "SF Mono", Menlo, monospace; font-size: 11.5px; color: #ffd79a;
    background: rgba(0,0,0,.25); border-radius: 4px; padding: 3px 7px; display: inline-block; margin-bottom: 7px; }
  .gate .body { font-size: 11.5px; color: #d8d0bd; line-height: 1.5; }
  .gate .body b { color: #ffd79a; font-weight: 600; }
  .gate .rev { font-size: 11px; color: #9ec9a4; margin-top: 6px; line-height: 1.45; }
  .gate code { font-family: "SF Mono", Menlo, monospace; font-size: 11.5px; color: #ffd79a; }
  .gate .btns { display: flex; gap: 7px; margin-top: 9px; }
  .gate button { font: inherit; font-size: 11.5px; border-radius: 5px; padding: 4px 12px; border: 1px solid #4a4132;
    background: #1a1d24; color: #cdd6e3; }
  .gate button.primary { background: #ffb648; border-color: #ffb648; color: #2a1f08; font-weight: 600; }

  .undo { margin: 10px 16px 0; font-size: 11.5px; color: #5f6a7a; line-height: 1.5; }
  .undo code { font-family: "SF Mono", Menlo, monospace; font-size: 11px; color: #8b97a6; }
  .foot { flex-shrink: 0; padding: 10px 16px 12px; }
  .meter { display: flex; align-items: center; font-size: 11px; color: #6b7787; margin-bottom: 9px; }
  .meter .stop { margin-left: auto; color: #cdd6e3; border: 1px solid #333a48; border-radius: 5px; padding: 2px 9px; }
  .input { display: flex; align-items: center; gap: 8px; background: #12151b; border: 1px solid #232838;
    border-radius: 8px; padding: 8px 10px; }
  .input .ph { color: #5a6472; font-size: 12.5px; flex: 1; }
  .input svg { width: 15px; height: 15px; }
'''

CYCLE = 10.0          # seconds for one full loop
FADE = 0.45           # element fade-in duration
OUT_START, OUT_END = 8.6, 9.1   # everything clears here so the loop restarts clean

def pct(t):
    return round(t / CYCLE * 100, 3)

def seq_keyframes(delays):
    """One @keyframes per distinct delay, so the whole scene loops on a single clock."""
    out = []
    for d in sorted(set(delays)):
        name = "seq%s" % str(d).replace(".", "_")
        out.append(f"""  @keyframes {name} {{
    0%, {pct(d)}% {{ opacity: 0; transform: translateY(6px); }}
    {pct(d + FADE)}%, {pct(OUT_START)}% {{ opacity: 1; transform: translateY(0); }}
    {pct(OUT_END)}%, 100% {{ opacity: 0; transform: translateY(0); }}
  }}""")
    return "\n".join(out)

# every delay used in the scene
DELAYS = [0.5, 1.0, 1.8, 2.6, 2.8, 3.0, 3.4, 4.4, 4.6, 5.0]

ANIM_CSS = """
  @keyframes bob { 0%,100% { transform: translateY(0) rotate(-1deg); } 50% { transform: translateY(-5px) rotate(1deg); } }
""" + seq_keyframes(DELAYS) + f"""
  @keyframes faceThink {{
    0%, {pct(4.3)}% {{ opacity: 1; }}
    {pct(4.6)}%, 100% {{ opacity: 0; }}
  }}
  @keyframes faceTalk {{
    0%, {pct(4.3)}% {{ opacity: 0; }}
    {pct(4.6)}%, {pct(OUT_START)}% {{ opacity: 1; }}
    {pct(OUT_END)}%, 100% {{ opacity: 0; }}
  }}
  .seq {{ opacity: 0; animation-duration: {CYCLE}s; animation-iteration-count: infinite;
         animation-timing-function: ease; }}
  .bob {{ animation: bob 4s ease-in-out infinite; transform-origin: 100px 100px; }}
  #face-think {{ animation: faceThink {CYCLE}s ease infinite; }}
  #face-talk  {{ opacity: 0; animation: faceTalk {CYCLE}s ease infinite; }}
  #sb-think {{ animation: faceThink {CYCLE}s ease infinite; }}
  #sb-talk   {{ opacity: 0; animation: faceTalk {CYCLE}s ease infinite; position: absolute; }}
  .sb-state {{ position: relative; }}
"""

def steps_html(anim):
    d = ((lambda t: ' style="animation-name:seq%s"' % str(t).replace('.', '_'))
         if anim else (lambda t: ''))
    cls = "step seq" if anim else "step"
    return f'''
      <div class="{cls} done"{d(1.0)}><span class="ic">✓</span><span>Read <code>checkout.js</code>, <code>checkout.test.js</code></span></div>
      <div class="{cls} done"{d(1.8)}><span class="ic">✓</span><span>Ran <code>npm test</code> — 1 failing</span></div>
      <div class="{cls} done"{d(2.6)}><span class="ic">✓</span><span>Edited <code>checkout.js</code> — scoped <code>cache</code></span></div>
      <div class="{cls} run"{d(3.4)}><span class="ic">⟳</span><span>Running <code>npm test</code>…</span></div>'''

def page(anim):
    d = ((lambda t: ' style="animation-name:seq%s"' % str(t).replace('.', '_'))
         if anim else (lambda t: ''))
    sb_state = ('<span id="sb-think">◐ thinking</span><span id="sb-talk">◉ talking</span>'
                if anim else '◉ talking')
    seq = " seq" if anim else ""
    bob = " bob" if anim else ""
    if anim:
        face = (f'<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">{DEFS}'
                f'<g class="{bob.strip()}"><g id="face-think">{avatar("thinking")}</g>'
                f'<g id="face-talk">{avatar("talking")}</g></g></svg>')
    else:
        face = f'<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">{DEFS}<g>{avatar("talking")}</g></svg>'

    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Clarvis — mockup</title><style>{CSS}{ANIM_CSS if anim else ""}</style></head>
<body>
<div class="titlebar">
  <div class="dots"><div class="dot" style="background:#ff5f57"></div><div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div></div>
  checkout.js — clarvis-demo
</div>
<div class="main">
  <div class="activitybar">
    <svg class="icon active" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6"><path d="M4 4h9l2 2h5v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></svg>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.6"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5V15.5M8 7l8 3.5M8 17l8-3.5"/></svg>
    <div class="spacer"></div>
    <svg class="icon active" viewBox="0 0 24 24"><path fill="#34e6f2" d="M2 6l8 4.2v3.6L2 18V6zm20 0v12l-8-4.2v-3.6L22 6zM12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>
  </div>
  <div class="explorer">
    <div class="section-title">CLARVIS-DEMO</div>
    <div class="file">📁 src</div>
    <div class="file active" style="padding-left:44px">checkout.js<span class="badge">M</span></div>
    <div class="file" style="padding-left:44px;color:#888">checkout.test.js</div>
    <div class="file" style="padding-left:44px;color:#888">package.json</div>
  </div>
  <div class="editor">
    <div class="tabs"><div class="tab active">🟨 checkout.js <span style="margin-left:4px;color:#888">✕</span></div></div>
    <div class="code">
      <div class="line"><span class="ln">1</span><span class="src"><span class="cm">// checkout.js — totals the cart, applies the promo cache</span></span></div>
      <div class="line"><span class="ln">2</span><span class="src"></span></div>
      <div class="line del{seq}"{d(2.6)}><span class="ln">3</span><span class="src">- <span class="glob">cache</span> = {{}};</span></div>
      <div class="line add{seq}"{d(2.8)}><span class="ln">3</span><span class="src">+ <span class="kw">const</span> cache = {{}};</span></div>
      <div class="line"><span class="ln">4</span><span class="src"></span></div>
      <div class="line"><span class="ln">5</span><span class="src"><span class="kw">function</span> <span class="fn">computeTotal</span>(items) {{</span></div>
      <div class="line"><span class="ln">6</span><span class="src">  <span class="kw">let</span> total = <span class="num">0</span>;</span></div>
      <div class="line"><span class="ln">7</span><span class="src">  <span class="kw">for</span> (<span class="kw">const</span> item <span class="kw">of</span> items) {{</span></div>
      <div class="line"><span class="ln">8</span><span class="src">    total += item.<span class="prop">price</span> * item.<span class="prop">qty</span>;</span></div>
      <div class="line"><span class="ln">9</span><span class="src">  }}</span></div>
      <div class="line"><span class="ln">10</span><span class="src">  cache[items.<span class="prop">id</span>] = total;</span></div>
      <div class="line"><span class="ln">11</span><span class="src">  <span class="kw">return</span> total;</span></div>
      <div class="line"><span class="ln">12</span><span class="src">}}</span></div>
      <div class="line"><span class="ln">13</span><span class="src"></span></div>
      <div class="line"><span class="ln">14</span><span class="src"><span class="kw">module</span>.<span class="prop">exports</span> = {{ <span class="fn">computeTotal</span> }};</span></div>
    </div>
  </div>

  <div class="clarvis">
    <div class="clarvis-header">CLARVIS<span class="branch{seq}"{d(0.5)}>⎇ clarvis/fix-checkout-test</span></div>
    <div class="stage">{face}</div>
    <div class="task">
      <div class="label">TASK</div>
      <div class="goal">"fix the failing checkout test"</div>
    </div>
    <div class="divider"></div>
    <div class="pbody">
    <div class="steps">{steps_html(anim)}</div>
    <div class="changed{seq}"{d(3.0)}>
      <div class="hd">FILES CHANGED</div>
      <div class="row">checkout.js<span class="plus">+1</span><span class="minus">−1</span></div>
    </div>
    <div class="said{seq}"{d(4.4)}><span class="spk">◉</span><span>"Its dependency tree
      would like a word with you. I'd decline, personally — but it's your machine."</span></div>
    <div class="gate{seq}"{d(4.6)}>
      <div class="hd">⚠ NEEDS YOUR APPROVAL — REVERSIBLE</div>
      <div class="cmd">npm install lodash</div>
      <div class="body">Installing a package runs its install scripts with your
        permissions. <b>Adds 1 direct and 4 transitive dependencies</b>, and modifies
        <b>package.json</b> and <b>package-lock.json</b>.</div>
      <div class="rev">↩ Undoable — <b>Undo Last Agent Run</b> restores both files, though
        anything an install script did outside the project stays done.</div>
      <div class="btns"><button class="primary">Approve</button><button>Skip</button></div>
    </div>
    <div class="undo{seq}"{d(5.0)}>On its own branch. Undone in one command.</div>
    </div>
    <div class="foot">
      <div class="meter"><span>step 4/40 · 12.4k tokens</span><span class="stop">■ Stop</span></div>
      <div class="input">
        <svg viewBox="0 0 24 24" fill="none" stroke="#8291a3" stroke-width="1.8"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
        <div class="ph">Ask Clarvis…</div>
        <svg viewBox="0 0 24 24" fill="none" stroke="#34e6f2" stroke-width="1.8"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/></svg>
      </div>
    </div>
  </div>
</div>
<div class="statusbar">
  <span>⎇ clarvis/fix-checkout-test</span><span>⚠ 0 ⓧ 0</span>
  <div class="right"><span class="sb-state">{sb_state}</span><span>Ln 3, Col 12</span><span>JavaScript</span></div>
</div>
</body></html>'''

os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, "mockup-demo.html"), "w").write(page(anim=True))
open(os.path.join(OUT, "_mockup_static.html"), "w").write(page(anim=False))
print("wrote mockup-demo.html + _mockup_static.html")
