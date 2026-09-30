"""Browser descendants and scratch cleanup must not outlive/mask render jobs."""
import contextlib
import io
import os
from pathlib import Path
import signal
import subprocess
import unittest
from unittest.mock import Mock, call, patch

from framewright import render


class BrowserLifecycleTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups")
    def test_posix_kills_group_even_when_parent_exits_first(self):
        chrome = Mock(pid=4321)
        with patch.object(render.os, "name", "posix"), patch.object(render.os, "killpg", create=True) as killpg:
            render.stop_browser(chrome)
        self.assertEqual(killpg.call_args_list, [call(4321, signal.SIGTERM), call(4321, signal.SIGKILL)])
        self.assertEqual(chrome.wait.call_count, 2)
        chrome.terminate.assert_not_called()

    @unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups")
    def test_posix_timeout_still_kills_remaining_children_and_reaps(self):
        chrome = Mock(pid=4321)
        chrome.wait.side_effect = [subprocess.TimeoutExpired("chrome", 5), 0]
        with patch.object(render.os, "name", "posix"), patch.object(render.os, "killpg", create=True) as killpg:
            render.stop_browser(chrome)
        killpg.assert_called_with(4321, signal.SIGKILL)
        self.assertEqual(chrome.wait.call_count, 2)

    @unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups")
    def test_already_exited_group_is_harmless(self):
        chrome = Mock(pid=4321)
        with patch.object(render.os, "name", "posix"), \
                patch.object(render.os, "killpg", side_effect=ProcessLookupError, create=True):
            render.stop_browser(chrome)
        chrome.wait.assert_called_with(timeout=5)

    def test_windows_targets_only_our_pid_tree(self):
        chrome = Mock(pid=4321)
        with patch.object(render.os, "name", "nt"), patch.object(render.subprocess, "run") as run:
            render.stop_browser(chrome)
        self.assertEqual(run.call_args.args[0], ["taskkill", "/PID", "4321", "/T", "/F"])
        chrome.wait.assert_called_once_with(timeout=5)

    def test_scratch_cleanup_failure_does_not_mask_completed_render(self):
        profile = Mock(name="profile")
        profile.name = "scratch-profile"
        profile.cleanup.side_effect = OSError("Directory not empty")
        chrome = Mock(pid=4321)
        with patch.object(render.tempfile, "TemporaryDirectory", return_value=profile) as temporary, \
                patch.object(render.subprocess, "Popen", return_value=chrome) as popen, \
                patch.object(render, "stop_browser") as stop, \
                patch.object(render.os, "name", "posix"), \
                patch.object(render.RenderHandler.done, "wait", return_value=True), \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertTrue(render.browser_session("chrome", "http://127.0.0.1:1234", 1))
        temporary.assert_called_once_with(prefix="studio-render-", ignore_cleanup_errors=True)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        stop.assert_called_once_with(chrome)
        self.assertIn("warning: could not remove temporary browser profile", stderr.getvalue())
        self.assertNotIn("browser session failed", stderr.getvalue())

    def test_failed_launch_cleans_profile_without_signaling_unknown_pid(self):
        profile = Mock()
        profile.name = "scratch-profile"
        with patch.object(render.tempfile, "TemporaryDirectory", return_value=profile), \
                patch.object(render.subprocess, "Popen", side_effect=OSError("launch failed")), \
                patch.object(render, "stop_browser") as stop:
            with self.assertRaisesRegex(OSError, "launch failed"):
                render.browser_session("chrome", "http://127.0.0.1:1234", 1)
        stop.assert_not_called()
        profile.cleanup.assert_called_once()

    def test_main_returns_success_when_only_profile_cleanup_fails(self):
        profile = Mock()
        profile.name = "scratch-profile"
        profile.cleanup.side_effect = OSError("Directory not empty")
        server = Mock(server_address=("127.0.0.1", 1234))
        job = {"id": "0", "shoot": "shoot", "key": "frame", "name": "edit", "out": Path("result.jpg")}

        def completed(_timeout):
            render.RenderHandler.results["0"] = {"note": ""}
            return True

        with patch.object(render, "resolve_library", return_value=Path("library")), \
                patch.object(render, "plan", return_value=[job]), \
                patch.object(render, "find_chrome", return_value="chrome"), \
                patch.object(render, "ThreadingHTTPServer", return_value=server), \
                patch.object(render.threading, "Thread"), \
                patch.object(render.tempfile, "TemporaryDirectory", return_value=profile), \
                patch.object(render.subprocess, "Popen"), patch.object(render, "stop_browser"), \
                patch.object(render.RenderHandler.done, "wait", side_effect=completed), \
                contextlib.redirect_stdout(io.StringIO()) as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(render.main(["shoot/frame"]), 0)
        self.assertIn("result.jpg", stdout.getvalue())
        self.assertIn("warning:", stderr.getvalue())
        self.assertNotIn("browser session failed", stderr.getvalue())
        server.shutdown.assert_called_once()
        server.server_close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
