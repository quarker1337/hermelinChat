import os
import unittest
from unittest import mock

from hermelin import __main__ as hermelin_main


class LanCliTests(unittest.TestCase):
    def _run_main(self, *args: str):
        env = {
            "HERMELIN_HOST": "127.0.0.1",
            "HERMELIN_ALLOWED_IPS": "127.0.0.1,::1",
            "HERMELIN_SSL_CERTFILE": "/tmp/hermelin-cert.pem",
            "HERMELIN_SSL_KEYFILE": "/tmp/hermelin-key.pem",
        }
        with (
            mock.patch.dict(os.environ, env, clear=False),
            mock.patch("sys.argv", ["hermelin", *args]),
            mock.patch.object(hermelin_main, "create_app") as create_app,
            mock.patch.object(hermelin_main.uvicorn, "run") as uvicorn_run,
        ):
            hermelin_main.main()
        return create_app, uvicorn_run

    def test_lan_mode_binds_all_ipv4_interfaces_and_allows_private_networks(self):
        create_app, uvicorn_run = self._run_main("--lan")

        config = create_app.call_args.args[0]
        self.assertEqual(config.host, "0.0.0.0")
        self.assertEqual(config.allowed_ips, hermelin_main.LAN_ALLOWED_IPS)
        self.assertEqual(uvicorn_run.call_args.kwargs["host"], "0.0.0.0")

    def test_lan_mode_keeps_an_explicit_allowlist(self):
        create_app, _ = self._run_main("--lan", "--allowed-ips", "192.168.178.0/24")

        config = create_app.call_args.args[0]
        self.assertEqual(config.allowed_ips, "192.168.178.0/24")

    def test_lan_mode_refuses_plain_http_by_default(self):
        env = {
            "HERMELIN_SSL_CERTFILE": "",
            "HERMELIN_SSL_KEYFILE": "",
        }
        with (
            mock.patch.dict(os.environ, env, clear=False),
            mock.patch("sys.argv", ["hermelin", "--lan"]),
            mock.patch.object(hermelin_main.uvicorn, "run") as uvicorn_run,
        ):
            with self.assertRaises(SystemExit) as raised:
                hermelin_main.main()

        self.assertEqual(raised.exception.code, 1)
        uvicorn_run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
