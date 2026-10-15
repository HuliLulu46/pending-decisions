# Replays one transcript turn through the sidecar prompt of a register.tsx and
# prints what Haiku adds on each run, to compare prompt versions.
# Usage: python3 scripts/eval-prompt.py <register.tsx> <transcript.jsonl> <text in the AI reply> <runs>
# The turn is the last AI reply holding <text>; open items are taken as none.
import json, re, subprocess, sys, tempfile
src, transcript, marker, runs = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
work = tempfile.mkdtemp(prefix='pending-decisions-eval-')
code = open(src).read()
system = re.search(r"export const SYSTEM = `([\s\S]*?)`", code).group(1)
template = re.search(r"export const buildPrompt = \([^)]*\) => `([\s\S]*?)`\n", code).group(1)

rows = [json.loads(l) for l in open(transcript)]
def text(r):
    c = r.get('message', {}).get('content')
    if isinstance(c, str): return c
    return '\n'.join(b.get('text', '') for b in c if b.get('type') == 'text') if isinstance(c, list) else ''
hit = max(i for i, r in enumerate(rows) if r.get('type') == 'assistant' and marker in text(r))
start = max(i for i in range(hit) if rows[i].get('type') == 'user' and not rows[i].get('isMeta')
            and isinstance(rows[i]['message']['content'], str) or (rows[i].get('type') == 'user' and isinstance(rows[i]['message']['content'], list)
            and not any(b.get('type') == 'tool_result' for b in rows[i]['message']['content']) and text(rows[i]).strip()))
user_text = text(rows[start])
ai_text = '\n\n'.join(text(r) for r in rows[start + 1:hit + 1] if r.get('type') == 'assistant' and text(r).strip())

prompt = template
prompt = re.sub(r"\$\{JSON\.stringify\([\s\S]*?\)\)\}", '[]', prompt, count=1)
prompt = re.sub(r"\$\{userText[^}]*\}", lambda m: user_text, prompt)
prompt = re.sub(r"\$\{aiText[^}]*\}", lambda m: ai_text[-12000:], prompt)
for n in range(runs):
    out = subprocess.run(['claude', '-p', '--model', 'claude-haiku-5-5', '--system-prompt', system, '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands'],
                         input=prompt, capture_output=True, text=True, cwd=work).stdout
    try:
        added = json.loads(out[out.index('{'):out.rindex('}') + 1]).get('added', [])
        print(f'run {n + 1}:', [(a.get('kind'), a.get('title')) for a in added])
    except Exception:
        print(f'run {n + 1}: unparsed:', out[:300])
