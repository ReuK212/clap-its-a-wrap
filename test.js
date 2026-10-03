#!/usr/bin/env node
/**
 * Simple test runner for clap-its-a-wrap
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

console.log('Running clap-its-a-wrap tests...\n');

let passed = 0;
let failed = 0;

function test(description, fn) {
    try {
        fn();
        console.log(`✓ ${description}`);
        passed++;
    } catch (error) {
        console.error(`✗ ${description}`);
        console.error(`  ${error.message}`);
        failed++;
    }
}

// Test 1: Required files exist
const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(pkgDir, 'bin');
const libDir = path.join(pkgDir, 'lib');

test('bin/clap exists', () => {
    if (!fs.existsSync(path.join(binDir, 'clap'))) {
        throw new Error('bin/clap not found');
    }
});

for (const file of ['server.js', 'config.js', 'codeium.js', 'models.js', 'models.json', 'routes.json', 'policy.json', 'translate.js', 'proto.js']) {
    test(`lib/proxy/src/${file} exists`, () => {
        if (!fs.existsSync(path.join(libDir, 'proxy', 'src', file))) {
            throw new Error(`proxy ${file} not found`);
        }
    });
}

// Test 1b: Proxy and CLI parse (catches syntax errors that existence checks miss)
for (const rel of ['bin/clap', ...fs.readdirSync(path.join(libDir, 'proxy', 'src'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join('lib', 'proxy', 'src', f))]) {
    test(`${rel} passes node --check`, () => {
        execFileSync(process.execPath, ['--check', path.join(pkgDir, rel)], { stdio: 'pipe' });
    });
}

// Test 2: bin/clap is executable
try {
    const stats = fs.statSync(path.join(binDir, 'clap'));
    test('bin/clap has correct permissions', () => {
        // On Unix, check executable bit
        if (process.platform !== 'win32' && !(stats.mode & fs.constants.S_IXUSR)) {
            throw new Error('bin/clap is not executable');
        }
    });
} catch (error) {
    // Skip on Windows or if file doesn't exist
}

// Test 3: bin/clap has shebang
test('bin/clap has shebang', () => {
    const content = fs.readFileSync(path.join(binDir, 'clap'), 'utf8');
    if (!content.startsWith('#!')) {
        throw new Error('Missing shebang line');
    }
});

// Test 4: bin/clap has proxy resolution logic
test('bin/clap has proxy resolution logic', () => {
    const content = fs.readFileSync(path.join(binDir, 'clap'), 'utf8');
    if (!content.includes('resolveProxyDir')) {
        throw new Error('Missing resolveProxyDir function');
    }
    if (!content.includes('--proxy')) {
        throw new Error('Missing --proxy flag handling');
    }
    if (!content.includes('--update')) {
        throw new Error('Missing --update flag handling');
    }
});

// Test 5: bin/clap sets ANTHROPIC_BASE_URL
test('bin/clap sets ANTHROPIC_BASE_URL', () => {
    const content = fs.readFileSync(path.join(binDir, 'clap'), 'utf8');
    if (!content.includes('ANTHROPIC_BASE_URL')) {
        throw new Error('Missing ANTHROPIC_BASE_URL setup');
    }
});

// Test 6: Models JSON has content
test('models.json has content', () => {
    const modelsJsonPath = path.join(libDir, 'proxy', 'src', 'models.json');
    const content = fs.readFileSync(modelsJsonPath, 'utf8');
    const models = JSON.parse(content);
    if (!Array.isArray(models) || models.length === 0) {
        throw new Error('models.json is empty or invalid');
    }
});

// Test 7: Model routing
const { loadRoutes, routeModel } = await import('./lib/proxy/src/routing.js');
const routes = loadRoutes({});
for (const [requested, expected] of [
    ['claude-opus-5-5', 'swe-2-max'],
    ['claude-opus-5-5[1m]', 'swe-2-max'],
    ['claude-fable-5-1', 'swe-2-max'],
    ['claude-sonnet-5-5', 'swe-2-high'],
    ['claude-haiku-4-5-20251001', 'swe-2-medium'],
    ['claude-something-new', 'swe-2-high'],
    ['swe-2-medium', 'swe-2-medium'],
    ['glm-5-2', 'glm-5-2'],
]) {
    test(`routes ${requested} -> ${expected}`, () => {
        const got = routeModel(requested, routes);
        if (got !== expected) throw new Error(`got ${got}`);
    });
}

test('CCP_ROUTES overrides: exact beats glob, "" passes through', () => {
    const r = loadRoutes({ CCP_ROUTES: '{"claude-opus-5-5":"glm-5-2","claude-sonnet-*":""}' });
    if (routeModel('claude-opus-5-5', r) !== 'glm-5-2') throw new Error('exact override ignored');
    if (routeModel('claude-opus-4-8', r) !== 'swe-2-max') throw new Error('glob lost');
    if (routeModel('claude-sonnet-5-5', r) !== 'claude-sonnet-5-5') throw new Error('passthrough failed');
});

test('CCP_ROUTING=off disables routing', () => {
    if (routeModel('claude-opus-5-5', loadRoutes({ CCP_ROUTING: 'off' })) !== 'claude-opus-5-5')
        throw new Error('still routed');
});

test('routes.json targets exist in models.json snapshot', () => {
    const ids = new Set(JSON.parse(fs.readFileSync(path.join(libDir, 'proxy', 'src', 'models.json'), 'utf8')).map((m) => m.id));
    const missing = Object.values(routes).filter((t) => t && !ids.has(t));
    if (missing.length) throw new Error(`unknown targets: ${missing.join(', ')}`);
});

// Test 8: Tool descriptions avoid the upstream filter
const { sanitizeToolDesc } = await import('./lib/proxy/src/translate.js');
test('sanitizeToolDesc rewrites Claude self-references, keeps "Claude Code"', () => {
    const got = sanitizeToolDesc("- Allows Claude to search. Beyond Claude's cutoff. Run Claude Code.");
    const want = "- Allows the assistant to search. Beyond the assistant's cutoff. Run Claude Code.";
    if (got !== want) throw new Error(`got ${JSON.stringify(got)}`);
});

// Test 9: GET /routes and `clap --routes` against a live proxy (no API key needed)
{
    const { spawn } = await import('child_process');
    const port = String(19000 + Math.floor(Math.random() * 1000));
    const env = { ...process.env, CCP_PORT: port, CCP_ROUTES: '{"claude-test-x":"swe-1-6"}' };
    const server = spawn(process.execPath, [path.join(libDir, 'proxy', 'src', 'server.js')], { env, stdio: 'ignore' });
    let info = null;
    for (let i = 0; i < 50 && !info; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { info = await (await fetch(`http://127.0.0.1:${port}/routes`)).json(); } catch {}
    }
    try {
        test('GET /routes reports active routes incl. CCP_ROUTES override', () => {
            if (!info) throw new Error('proxy did not answer /routes');
            if (!info.enabled || info.routes['claude-opus-*'] !== 'swe-2-max' || info.routes['claude-test-x'] !== 'swe-1-6')
                throw new Error(JSON.stringify(info.routes));
            if (!Array.isArray(info.seen)) throw new Error('missing seen[]');
        });
        test('clap --routes prints the live routes', () => {
            const out = execFileSync(path.join(binDir, 'clap'), ['--routes'], { env, encoding: 'utf8' });
            if (!/routing on/.test(out) || !/claude-test-x\s+->\s+swe-1-6/.test(out)) throw new Error(out);
        });
        // Stub `claude` that echoes the env clap hands it
        const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clap-test-'));
        fs.writeFileSync(path.join(stubDir, 'claude'),
            '#!/bin/sh\necho "BASE=$ANTHROPIC_BASE_URL WINDOW=$CLAUDE_CODE_AUTO_COMPACT_WINDOW"\n', { mode: 0o755 });
        const runClap = (extra) => execFileSync(path.join(binDir, 'clap'), [], {
            env: { ...env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}`, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '', ...extra },
            encoding: 'utf8',
        });
        test('clap points claude at the proxy and caps the compact window', () => {
            const out = runClap({});
            if (!out.includes(`BASE=http://127.0.0.1:${port} `) || !out.includes('WINDOW=262000')) throw new Error(out);
        });
        test('clap keeps a user-set compact window and skips it with routing off', () => {
            if (!runClap({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }).includes('WINDOW=500000')) throw new Error('override lost');
            if (!/WINDOW=\s*$/m.test(runClap({ CCP_ROUTING: 'off' }))) throw new Error('set despite CCP_ROUTING=off');
        });
        fs.rmSync(stubDir, { recursive: true, force: true });
    } finally {
        server.kill();
    }
}

// Test 11: allowlist policy
const { loadPolicy, applyPolicy } = await import('./lib/proxy/src/routing.js');
test('allowlist: allowed passes, blocked reroutes or rejects, empty allows all', () => {
    const empty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clap-policy-')), 'models.json');
    fs.writeFileSync(empty, JSON.stringify({ allowed: [], reroute_blocked_to: null }));
    const reroute = loadPolicy({ CCP_ALLOWED_MODELS: 'swe-2-high, swe-1-*', CCP_REROUTE_BLOCKED_TO: 'swe-2-high' });
    const check = (got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(JSON.stringify(got)); };
    check(applyPolicy('swe-1-6', reroute), { model: 'swe-1-6', blocked: false });
    check(applyPolicy('swe-2-max', reroute), { model: 'swe-2-high', blocked: true });
    check(applyPolicy('swe-2-max', loadPolicy({ CCP_ALLOWED_MODELS: 'swe-2-high', CCP_REROUTE_BLOCKED_TO: '' })), { model: null, blocked: true });
    check(applyPolicy('anything', loadPolicy({ CCP_POLICY_FILE: empty })), { model: 'anything', blocked: false });
    fs.rmSync(path.dirname(empty), { recursive: true, force: true });
});
test('allowlist: bundled default allows swe-2-*, sends the rest to swe-2-high', () => {
    const def = loadPolicy({ CCP_POLICY_FILE: path.join(os.tmpdir(), 'clap-no-such-policy.json') });
    const ids = JSON.parse(fs.readFileSync(path.join(libDir, 'proxy', 'src', 'models.json'), 'utf8')).map((m) => m.id);
    if (!ids.includes(def.reroute)) throw new Error(`default reroute target ${def.reroute} not in models.json`);
    const check = (got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(JSON.stringify(got)); };
    check(applyPolicy('swe-2-max', def), { model: 'swe-2-max', blocked: false });
    check(applyPolicy('glm-5-2', def), { model: 'swe-2-high', blocked: true });
});
test('allowlist: env overrides the policy file; reroute target must be allowed', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clap-policy-')), 'models.json');
    fs.writeFileSync(file, JSON.stringify({ allowed: ['swe-2-high'], reroute_blocked_to: 'swe-2-high' }));
    if (loadPolicy({ CCP_POLICY_FILE: file }).reroute !== 'swe-2-high') throw new Error('file ignored');
    if (loadPolicy({ CCP_POLICY_FILE: file, CCP_REROUTE_BLOCKED_TO: '' }).reroute !== null) throw new Error('env override ignored');
    let threw = false;
    try { loadPolicy({ CCP_ALLOWED_MODELS: 'swe-2-high', CCP_REROUTE_BLOCKED_TO: 'swe-2-max' }); } catch { threw = true; }
    if (!threw) throw new Error('accepted a reroute target outside the allowlist');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

// Test 13: clap --doctor reports a missing claude and API key without installing
test('clap --doctor flags missing claude and API key, installs nothing on "n"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clap-doctor-'));
    try {
        const env = { ...process.env, PATH: '/usr/bin:/bin', CLAP_WORKSPACE: dir, CLAP_CACHE_DIR: dir,
            CCP_API_KEY: '', COGNITION_API_KEY: '', CCP_CREDENTIALS: path.join(dir, 'none') };
        let out, code = 0;
        try {
            out = execFileSync(process.execPath, [path.join(binDir, 'clap'), '--doctor'], { env, input: 'n\n', encoding: 'utf8' });
        } catch (e) { out = e.stdout; code = e.status; }
        if (code !== 1 || !/MISS\s+API key/.test(out) || !/MISS\s+claude/.test(out) || !/2 problem/.test(out))
            throw new Error(`exit ${code}\n${out}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Test 12: clap --setup-models (scripted) + a proxy enforcing the saved file
{
    const { spawn } = await import('child_process');
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clap-setup-'));
    const port = String(20000 + Math.floor(Math.random() * 1000)); // nothing listens: uses the bundled snapshot
    const env = { ...process.env, CLAP_CACHE_DIR: cacheDir, CCP_PORT: port, CLAP_WORKSPACE: cacheDir };
    delete env.CCP_ALLOWED_MODELS; delete env.CCP_REROUTE_BLOCKED_TO; delete env.CCP_POLICY_FILE;
    test('clap --setup-models saves the allowlist and reroute choice', () => {
        const out = execFileSync(path.join(binDir, 'clap'), ['--setup-models'],
            { env, input: 'not-a-model\nswe-2-high,swe-2-medium\n0\n', encoding: 'utf8' });
        if (!/Not in the catalog: not-a-model/.test(out)) throw new Error('unknown model not rejected');
        const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'models.json'), 'utf8'));
        if (saved.allowed.join() !== 'swe-2-high,swe-2-medium' || saved.reroute_blocked_to !== null) throw new Error(JSON.stringify(saved));
    });
    const server = spawn(process.execPath, [path.join(libDir, 'proxy', 'src', 'server.js')],
        { env: { ...env, CCP_POLICY_FILE: path.join(cacheDir, 'models.json') }, stdio: 'ignore' });
    let res = null;
    for (let i = 0; i < 50 && !res; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
            res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
            });
        } catch {}
    }
    const body = res ? await res.json() : null;
    server.kill();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    test('proxy rejects a blocked model with a 400 naming the allowlist', () => {
        if (!res || res.status !== 400 || !/swe-2-max \(routed from claude-opus-5-5\) is not allowed/.test(body.error.message))
            throw new Error(JSON.stringify({ status: res?.status, body }));
    });
}

// Test 10: [model: ...] marker before answers, stripped from history
const { ChiselToAnthropicStream, eventsToMessage, anthropicToChisel } = await import('./lib/proxy/src/translate.js');
test('streaming answer starts with the routed model marker, once', () => {
    const tx = new ChiselToAnthropicStream('claude-opus-5-5', 'swe-2-max');
    const sse = [...tx.feed({ thinking: 'hm' }), ...tx.feed({ text: 'po' }), ...tx.feed({ text: 'ng' }), ...tx.finish()].join('');
    const texts = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
    if (texts.join('') !== '[model: swe-2-max]\\npong') throw new Error(JSON.stringify(texts));
    if (!sse.includes('"model":"claude-opus-5-5"')) throw new Error('requested model not echoed');
});
test('non-streaming answer gets the marker; none without a label', () => {
    const evs = [{ tool: { id: 't1', name: 'Bash' } }, { toolArgsDelta: '{}' }, { text: 'done' }];
    const msg = eventsToMessage(evs, 'claude-opus-5-5', 'swe-2-max');
    if (msg.content.find((c) => c.type === 'text').text !== '[model: swe-2-max]\ndone') throw new Error(JSON.stringify(msg.content));
    if (eventsToMessage(evs, 'x').content.find((c) => c.type === 'text').text !== 'done') throw new Error('marker without label');
});
test('marker is stripped from assistant history sent upstream', () => {
    const r = anthropicToChisel({ messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: '[model: swe-2-max]\npong' }] },
        { role: 'user', content: 'again' },
    ] });
    if (r.messages[1].text !== 'pong') throw new Error(JSON.stringify(r.messages[1].text));
});

// Summary
console.log('\n' + '='.repeat(50));
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
console.log('='.repeat(50));

if (failed > 0) {
    process.exit(1);
}
