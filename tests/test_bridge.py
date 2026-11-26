"""Offline source, provider transport, evidence, authentication and spending regressions."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from dataclasses import replace
from decimal import Decimal
from http import client
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest.mock import patch
import json
import secrets
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import server as bridge


INTRO = ("We study when a family of continuous functions admits a finite approximation. "
         "Compactness is a familiar condition on the space of functions. "
         "The research question concerns sequences of functions on a closed interval.")
ABSTRACT = "The research question concerns uniform limits of continuous real functions on a closed interval."
HTML = (f'<html><nav>Outside article</nav><article class="ltx_document"><h1>A fixture paper</h1>'
        f'<section id="S1"><h2>Introduction</h2><p>{INTRO} '
        r'<math alttext="\alpha_n"><mi>duplicate-glyph</mi></math>'
        '<script>ignore-me-script</script><span hidden>ignore-me-hidden</span></p></section>'
        '<section id="S2"><h2>Main results</h2><p>We prove an auxiliary identity for the sequence.</p>'
        '<div class="ltx_proof" id="S2.P"><h5>Proof</h5><p>The proof uses a construction.</p></div></section>'
        '<footer>Ignore footer</footer></article></html>').encode()


def request():
    return {"protocol": 1, "provider": "local", "model": "fixture-model", "action": "overview", "detail": "standard",
            "paper": {"id": "2401.12345", "version": 2, "title": "A fixture paper", "abstract": ABSTRACT},
            "term": "", "question": "", "context": "", "noSpoilers": False,
            "knowledge": [{"topic": "sequences", "level": "comfortable"}],
            "limits": {"maxInputChars": 8000, "maxOutputTokens": 512, "dailyRequests": 10, "dailyBudget": 1,
                       "inputPerMillion": 0, "outputPerMillion": 0}}


def make_config(path):
    env = {"ARXIV_AI_MODELS": "fixture-model,other-model", "ARXIV_AI_TOKEN": secrets.token_urlsafe(32),
           "ARXIV_AI_USAGE_DB": str(path)}
    return bridge.Config.from_env(env)


def completion(messages, *, bad_quotes=False):
    data = json.loads(messages[1]["content"])
    passage = next(p for p in data["passages"] if len(p["text"]) > 20)
    quote = "absent words from another source" if bad_quotes else passage["text"][:45]
    field = "context" if data["task"] == "explain" else "question"
    sections = [{"key": field, "text": "The paper poses a question about approximation.",
                 "evidence": [{"ref": passage["ref"], "quote": quote}]},
                {"key": "results", "text": "An unsupported result must be discarded.",
                 "evidence": [{"ref": "made-up", "quote": "an unverified claim"}]}]
    return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"sections": sections})}}],
            "usage": {"prompt_tokens": 58, "completion_tokens": 24}}


@contextmanager
def running(server):
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)


def simple_pdf(text, font=b"Helvetica"):
    # One small, born-digital test page with a conventional cross-reference table.
    stream = b"BT /F1 12 Tf 50 700 Td (" + text.encode("ascii") + b") Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /" + font + b" >>",
               b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(data)
    data += b"xref\n0 6\n0000000000 65535 f \n"
    for offset in offsets[1:]:
        data += f"{offset:010d} 00000 n \n".encode()
    data += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    return bytes(data)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cfg = make_config(Path(self.temp.name) / "usage.sqlite3")
        self.raw = request()
        self.req = bridge.validate_request(self.raw, self.cfg)

    def test_html_body_anchor_and_math_are_retained_without_active_markup(self):
        calls = []
        def fetch(kind, pid):
            calls.append((kind, pid))
            return HTML
        repo = bridge.SourceRepository(fetch)
        doc = repo.get(self.req)
        self.assertIs(doc, repo.get(self.req))
        self.assertEqual(calls, [("html", "2401.12345v2")])
        self.assertEqual(doc.kind, "html")
        combined = " ".join(p.text for p in doc.passages)
        self.assertIn(r"\alpha_n", combined)
        self.assertNotIn("ignore-me", combined)
        self.assertNotIn("duplicate-glyph", combined)
        self.assertNotIn("Outside article", combined)
        self.assertTrue(any(p.fragment == "#S1" and p.label == "Introduction" for p in doc.passages))

    def test_missing_html_pdf_fallback_and_location(self):
        calls = []
        def fetch(kind, _):
            calls.append(kind)
            if kind == "html":
                return b"<html><body>HTML unavailable</body></html>"
            return b"pdf fixture"
        repo = bridge.SourceRepository(fetch, lambda _: ((bridge.Passage("PDF page 4", "#page=4", INTRO),), False), True)
        source = repo.get(self.req)
        self.assertEqual(calls, ["html", "pdf"])
        self.assertEqual(source.kind, "pdf")
        self.assertEqual(source.passages[0].fragment, "#page=4")
        self.assertIn("fallback", source.note)

    @unittest.skipUnless(bridge.find_spec("pypdf"), "install optional pypdf for real PDF extraction")
    def test_isolated_pdf_worker_reads_text_and_rejects_unmapped_math_or_empty_pages(self):
        result, trimmed = bridge.pdf_text(simple_pdf(INTRO))
        self.assertFalse(trimmed)
        self.assertIn("finite approximation", result[0].text)
        self.assertEqual(result[0].fragment, "#page=1")
        for data in (b"not a PDF", simple_pdf(""), simple_pdf(INTRO, b"CMEX10")):
            with self.subTest(kind=data[:12]), self.assertRaises(bridge.SourceError):
                bridge.pdf_text(data)

    def test_pdf_quality_failure_is_disclosed_and_abstract_cache_does_not_trust_another_caller(self):
        def fetch(kind, _):
            if kind == "html":
                raise bridge.SourceError("missing HTML")
            return b"truncated PDF"
        def no_pdf(_):
            raise bridge.SourceError("unreadable PDF text")
        repo = bridge.SourceRepository(fetch, no_pdf, True)
        fallback = repo.get(self.req)
        self.assertEqual(fallback.kind, "abstract")
        self.assertIn("unreadable PDF", fallback.note)
        self.assertEqual(fallback.url, "https://arxiv.org/abs/2401.12345v2")
        another = {**self.req, "abstract": "The authentic abstract from the caller's own arXiv record."}
        self.assertEqual(repo.get(another).passages[0].text, another["abstract"])
        with self.assertRaises(bridge.BridgeError):
            repo.get({**self.req, "abstract": ""})

    def test_respects_backoff_and_optional_pdf_dependency(self):
        seen = []
        def fetch(kind, _):
            seen.append(kind)
            raise bridge.ArxivBackoff("arXiv requested a pause")
        source = bridge.SourceRepository(fetch, pdf_available=True).get(self.req)
        self.assertEqual(seen, ["html"])
        self.assertIn("pause", source.note)
        def missing(kind, _):
            self.assertEqual(kind, "html")
            raise bridge.SourceError("missing HTML")
        source = bridge.SourceRepository(missing, pdf_available=False).get(self.req)
        self.assertIn("pypdf", source.note)
        self.assertEqual(bridge.retry_seconds("15"), 15)

    def test_protected_mode_excludes_proof_and_results_sources_and_blocks_an_explicit_proof_question(self):
        repo = bridge.SourceRepository(lambda *_: HTML)
        protected = {**self.req, "protected": True}
        doc, note, evidence = bridge.prepare_evidence(protected, repo.get(protected))
        self.assertIn("Independent-research", note)
        self.assertTrue(all("proof uses" not in p.text and not p.label.startswith("Main") for p in evidence.values()))
        fields = bridge.answer_fields(protected)
        self.assertNotIn("results", [s[0] for s in fields])
        msgs = bridge.prompt_messages(protected, doc, evidence, fields)
        self.assertIn("protection is active", msgs[0]["content"])
        self.assertEqual(json.loads(msgs[1]["content"])["reader_topic_levels"][0]["level"], "comfortable")
        output = completion(msgs)
        danger = json.loads(output["choices"][0]["message"]["content"])
        danger["sections"][0]["text"] = "The authors prove the main result with this solution."
        output["choices"][0]["message"]["content"] = json.dumps(danger)
        with self.assertRaises(bridge.BridgeError):
            bridge.checked_answer(output, fields, evidence, doc, protected)
        app = bridge.Application(self.cfg, repo, lambda *_: self.fail("Should not call provider"))
        with self.assertRaisesRegex(bridge.BridgeError, "protects"):
            app.handle({**self.raw, "noSpoilers": True, "question": "Give the full proof."})

    def test_excerpt_limit_uses_term_neighborhood_and_discloses_coverage(self):
        rich = "A standard continuous function. " * 80 + "locally finite graph" + " more background" * 90
        source = bridge.Source("pdf", "https://arxiv.org/pdf/2401.12345v2", "PDF.", (bridge.Passage("PDF page 2", "#page=2", rich),))
        _, note, picked = bridge.prepare_evidence({**self.req, "term": "locally finite graph", "max_chars": 256}, source)
        self.assertLessEqual(sum(len(p.text) for p in picked.values()), 256)
        self.assertTrue(any("locally finite graph" in p.text for p in picked.values()))
        self.assertIn("excerpts", note)

    def test_unverified_claims_are_replaced_and_source_quotes_link_to_real_anchors(self):
        captured = []
        def provider(_, req, messages):
            captured.append((req, messages))
            return completion(messages)
        result = bridge.Application(self.cfg, bridge.SourceRepository(lambda *_: HTML), provider).handle(self.raw)
        self.assertIn("The supplied passages do not establish this.", result["text"])
        self.assertNotIn("unsupported result", result["text"])
        self.assertEqual(result["source"]["citations"][0]["url"], "https://arxiv.org/html/2401.12345v2#S1")
        sent_passages = json.loads(captured[0][1][1]["content"])["passages"]
        quote = result["source"]["citations"][0]["quotes"][0]
        self.assertTrue(any(quote in p["text"] for p in sent_passages))
        self.assertEqual(result["usage"]["inputTokens"], 58)
        self.assertEqual(result["usage"]["dailyRequests"], 1)
        self.assertEqual(len(captured), 1)
        app = bridge.Application(self.cfg, bridge.SourceRepository(lambda *_: HTML),
                                 lambda _, req, messages: completion(messages, bad_quotes=True))
        with self.assertRaisesRegex(bridge.BridgeError, "verifiable source quotation"):
            app.handle(self.raw)

    def test_recursive_general_dictionary_can_explain_a_background_term_absent_from_the_paper(self):
        def provider(_, req, messages):
            sent = json.loads(messages[1]["content"])
            self.assertEqual(sent["surrounding_reading_context"], "A prior explanation mentions this definition.")
            self.assertEqual(sent["term"], "bijection")
            sections = [{"key": "definition", "text": "A one-to-one correspondence between two sets.", "evidence": []},
                        {"key": "followup", "scope": "background", "text": "Each element has exactly one partner.", "evidence": []}]
            return {"choices": [{"message": {"content": json.dumps({"sections": sections})}}]}
        app = bridge.Application(self.cfg, bridge.SourceRepository(lambda *_: HTML), provider)
        result = app.handle({**self.raw, "action": "explain", "term": "bijection", "question": "What does that mean?",
                             "context": "A prior explanation mentions this definition."})
        self.assertIn("General background: A one-to-one", result["text"])
        self.assertIn("General background: Each element", result["text"])
        self.assertIn("The supplied passages do not establish this.", result["text"])
        self.assertIn("Token usage was unavailable", result["source"]["note"])

    def test_concurrent_reservations_and_restart_enforce_limits_atomically(self):
        ledger = bridge.Ledger(self.cfg.db)
        policy = {**self.req, "requests": 3, "budget": Decimal("0.000002")}
        def reserve(_):
            try:
                return ledger.reserve(1, policy)
            except bridge.BridgeError:
                return None
        with ThreadPoolExecutor(max_workers=8) as pool:
            accepted = [day for day in pool.map(reserve, range(8)) if day]
        self.assertEqual(len(accepted), 2)
        second_process = bridge.Ledger(self.cfg.db)
        with self.assertRaisesRegex(bridge.BridgeError, "budget"):
            second_process.reserve(1, policy)
        self.assertEqual(second_process.settle(accepted[0], 1, 0), (2, 1))
        second_process.reserve(1, policy)
        with self.assertRaisesRegex(bridge.BridgeError, "request limit"):
            ledger.reserve(0, policy)

    def test_spend_ceiling_includes_prompt_overhead_and_failed_provider_attempts(self):
        calls = []
        def fail(_, req, messages):
            calls.append(req)
            raise bridge.BridgeError("Configured model unavailable.", 502)
        cfg = replace(self.cfg, input_price=Decimal(2), output_price=Decimal(4))
        app = bridge.Application(cfg, bridge.SourceRepository(lambda *_: HTML), fail)
        self.raw["limits"]["dailyBudget"] = 0.000001
        with self.assertRaisesRegex(bridge.BridgeError, "budget"):
            app.handle(self.raw)
        self.assertFalse(calls)
        self.raw["limits"].update(dailyBudget=1, dailyRequests=1)
        with self.assertRaisesRegex(bridge.BridgeError, "reserved"):
            app.handle(self.raw)
        with self.assertRaisesRegex(bridge.BridgeError, "request limit"):
            app.handle(self.raw)
        self.assertEqual(len(calls), 1)
        with closing(sqlite3.connect(cfg.db)) as db:
            requests, cost = db.execute("SELECT requests,cost FROM daily").fetchone()
        self.assertEqual(requests, 1)
        self.assertGreater(cost, 1024 * 2 + 512 * 4)

    def test_hosted_config_requires_authoritative_prices_and_does_not_inherit_an_arbitrary_endpoint(self):
        env = {"ARXIV_AI_PROVIDER": "openai", "ARXIV_AI_MODELS": "fixture-model", "ARXIV_AI_TOKEN": self.cfg.token,
               "OPENAI_API_KEY": "offline-fixture", "OPENAI_BASE_URL": "https://example.org", "ARXIV_AI_USAGE_DB": str(self.cfg.db)}
        with self.assertRaisesRegex(bridge.BridgeError, "positive"):
            bridge.Config.from_env(env)
        cfg = bridge.Config.from_env({**env, "ARXIV_AI_INPUT_USD_PER_MILLION": "2", "ARXIV_AI_OUTPUT_USD_PER_MILLION": "3"})
        with self.assertRaisesRegex(bridge.BridgeError, "allowlist"):
            bridge.validate_request(self.raw, cfg)
        self.raw["provider"] = "openai"
        req = bridge.validate_request(self.raw, cfg)
        self.assertEqual(req["input_rate"], Decimal(2))
        with patch.object(bridge.client, "HTTPSConnection") as connect:
            conn = connect.return_value
            conn.getresponse.return_value.status = 200
            conn.getresponse.return_value.read.return_value = b'{"choices":[]}'
            bridge.provider_request(cfg, req, [{"role": "user", "content": "test"}])
            self.assertEqual(connect.call_args.args, ("api.openai.com",))
            args, kwargs = conn.request.call_args
            self.assertEqual(args, ("POST", "/v1/chat/completions"))
            payload = json.loads(kwargs["body"])
            self.assertEqual(payload["max_completion_tokens"], 512)
            self.assertFalse(payload["store"])
            self.assertNotIn("tools", payload)
            self.assertNotIn(cfg.api_key, kwargs["body"].decode())

    def test_invalid_request_fields_cannot_change_transport_or_disable_server_caps(self):
        cfg = replace(self.cfg, max_tokens=100, daily_requests=2)
        req = bridge.validate_request(self.raw, cfg)
        self.assertEqual(req["max_tokens"], 100)
        self.assertEqual(req["requests"], 2)
        for bad in [{**self.raw, "paper": {**self.raw["paper"], "id": "https://example.org/an-article"}},
                    {**self.raw, "model": "unlisted"}, {**self.raw, "noSpoilers": "false"},
                    {**self.raw, "knowledge": [{}]},
                    {**self.raw, "limits": {**self.raw["limits"], "dailyBudget": float("nan")}}]:
            with self.subTest(bad=list(bad)), self.assertRaises(bridge.BridgeError):
                bridge.validate_request(bad, cfg)

    def test_real_paired_http_bridge_to_loopback_provider(self):
        observed = []
        class LocalModel(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                received = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                observed.append((self.path, self.headers.get("Authorization"), received))
                data = bridge.json_bytes(completion(received["messages"]))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        with running(HTTPServer(("127.0.0.1", 0), LocalModel)) as model_port:
            cfg = replace(self.cfg, local_port=model_port)
            repo = bridge.SourceRepository(lambda *_: HTML)
            with running(bridge.LocalServer(0, bridge.Application(cfg, repo))) as port:
                auth = {"Authorization": "Bearer " + cfg.token, "Content-Type": "application/json"}
                for patch_headers, expected in [({"Authorization": "Bearer invalid"}, 401), ({"Host": "example.org"}, 403),
                                                ({"Origin": "https://example.org"}, 403), ({"Origin": "null"}, 403),
                                                ({"Content-Type": "text/plain"}, 415), ({"Origin": "https://arxiv.org"}, 200)]:
                    headers = {**auth, **patch_headers}
                    with closing(client.HTTPConnection("127.0.0.1", port, timeout=3)) as conn:
                        conn.request("POST", "/v1/explain", body=bridge.json_bytes(self.raw), headers=headers)
                        reply = conn.getresponse()
                        self.assertEqual(reply.status, expected)
                        self.assertIsNone(reply.getheader("Access-Control-Allow-Origin"))
                        obj = json.loads(reply.read())
                        if reply.status == 200:
                            self.assertEqual(obj["source"]["kind"], "html")
                self.assertEqual(len(observed), 1)
                path, credential, payload = observed[0]
                self.assertEqual(path, "/v1/chat/completions")
                self.assertIsNone(credential)
                self.assertEqual(payload["max_tokens"], 512)
                self.assertEqual(payload["response_format"], {"type": "json_object"})
                self.assertNotIn(cfg.token, json.dumps(payload))


if __name__ == "__main__":
    unittest.main()
