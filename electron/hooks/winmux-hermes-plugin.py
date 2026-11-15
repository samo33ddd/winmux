"""winmux-hermes-plugin

Hermes plugin hooks for Winmux lifecycle reporting. A project-file plugin
loader can copy this module into an explicitly enabled user plugin later. The
default transport invokes the configured Winmux Node helper over stdin and
never embeds the capability token.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import subprocess
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Mapping

MARKER = "winmux-hermes-plugin"
CONFIG_ENCODED = "__WINMUX_CONFIG_B64__"
EVENTS = {
    "session_start", "session_switch", "session_shutdown",
    "agent_start", "agent_end",
    "tool_execution_start", "tool_execution_end",
    "tool_approval_requested", "tool_approval_resolved",
}
STATES = {"idle", "running", "waiting", "completed", "failed"}
# Each CLI root needs its own source proof. Sharing a Hermes process and PID
# never makes desktop, Telegram, or another unknown session eligible.
ROOT_PLATFORMS = {"cli"}
_MISSING = object()


@dataclass
class _RootSession:
    session_id: str
    reporting_id: str
    platform: str
    cwd: str
    conversation_id: str | None = None
    session_started: bool = False


def _bounded(value: Any, limit: int) -> str | None:
    if not isinstance(value, str) or not value or len(value) > limit or "\0" in value:
        return None
    return value


def _load_config() -> dict[str, str]:
    if CONFIG_ENCODED == "__WINMUX_CONFIG_B64__":
        return {}
    try:
        value = json.loads(base64.b64decode(CONFIG_ENCODED, validate=True).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "delegated"}


def _delegated_context() -> bool | None:
    """Return Hermes' context marker, or None when root provenance is unprovable."""
    try:
        from agent.delegation_context import is_delegated_child_context
    except Exception:
        return None
    try:
        return bool(is_delegated_child_context())
    except Exception:
        return None


def send_via_helper(config: Mapping[str, str], payload: Mapping[str, Any]) -> None:
    node_path = _bounded(config.get("nodePath"), 4096)
    helper_path = _bounded(config.get("helperPath"), 4096)
    data_dir = _bounded(config.get("dataDir"), 4096)
    if not node_path or not helper_path or not data_dir:
        raise RuntimeError("Winmux Hermes hook configuration is incomplete")
    completed = subprocess.run(
        [node_path, helper_path, "--data-dir", data_dir],
        input=(json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=1.5,
        check=False,
        shell=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("Winmux Hermes hook delivery failed")


class WinmuxHermesPlugin:
    """Metadata-only bridge from Hermes plugin hooks to Winmux."""

    def __init__(
        self,
        config: Mapping[str, str] | None = None,
        *,
        send: Callable[[Mapping[str, Any]], Any] | None = None,
        monotonic_ns: Callable[[], int] = time.monotonic_ns,
        get_pid: Callable[[], int] = os.getpid,
        get_cwd: Callable[[], str] | None = None,
        delegated_context: Callable[[], bool] | None = None,
        environ: Mapping[str, str] | None = None,
        async_delivery: bool | None = None,
        max_identities: int = 512,
    ) -> None:
        self._config = dict(config or _load_config())
        self._send = send or (lambda payload: send_via_helper(self._config, payload))
        self._monotonic_ns = monotonic_ns
        self._get_pid = get_pid
        self._get_cwd = get_cwd
        self._delegated_context = delegated_context or _delegated_context
        self._environ = environ if environ is not None else os.environ
        self._max_identities = max_identities
        self._lock = threading.RLock()
        self._opened_sessions: OrderedDict[str, str] = OrderedDict()
        self._root_sessions: OrderedDict[str, _RootSession] = OrderedDict()
        self._root_by_conversation: OrderedDict[str, str] = OrderedDict()
        self._nested_sessions: OrderedDict[str, None] = OrderedDict()
        self._active: set[str] = set()
        self._waiting: dict[str, set[str]] = {}
        self._async = (send is None) if async_delivery is None else bool(async_delivery)
        self._queue: queue.Queue[Mapping[str, Any] | None] | None = None
        self._worker: threading.Thread | None = None
        if self._async:
            self._queue = queue.Queue(maxsize=128)
            self._worker = threading.Thread(
                target=self._delivery_loop,
                name="winmux-hermes-hooks",
                daemon=True,
            )
            self._worker.start()

    @staticmethod
    def _default_cwd(platform: str) -> str | None:
        try:
            from agent.runtime_cwd import resolve_agent_cwd
        except Exception:
            # A direct CLI's launch directory is the documented fallback. Shared
            # gateway surfaces have no pane-local cwd, so they fail closed.
            return os.getcwd() if platform == "cli" else None
        return str(resolve_agent_cwd())

    def _remember(
        self,
        values: OrderedDict[str, Any],
        key: str,
        value: Any = None,
    ) -> None:
        values[key] = value
        values.move_to_end(key)
        while len(values) > self._max_identities:
            values.popitem(last=False)

    def _remember_root(self, session: "_RootSession") -> None:
        self._remember(self._root_sessions, session.session_id, session)
        if session.conversation_id:
            self._remember(
                self._root_by_conversation,
                session.conversation_id,
                session.session_id,
            )

    def _forget_root(self, session_id: str) -> None:
        root = self._root_sessions.pop(session_id, None)
        if root and root.conversation_id:
            self._root_by_conversation.pop(root.conversation_id, None)
        self._opened_sessions.pop(session_id, None)
        self._active.discard(session_id)
        self._waiting.pop(session_id, None)

    def _remember_old(
        self, values: OrderedDict[str, None], value: str
    ) -> None:
        values[value] = None
        values.move_to_end(value)
        while len(values) > self._max_identities:
            values.popitem(last=False)

    def _session_id(self, meta: Mapping[str, Any]) -> str | None:
        return _bounded(meta.get("session_id") or meta.get("sessionId"), 128)

    def _conversation_id(self, meta: Mapping[str, Any]) -> str | None:
        return _bounded(
            meta.get("root_conversation_id")
            or meta.get("rootconversation")
            or meta.get("conversation_id")
            or meta.get("conversationId"),
            128,
        )

    def _mark_nested(self, meta: Mapping[str, Any]) -> None:
        parent = self._parent_session_id(meta)
        session_id = self._session_id(meta)
        if parent and session_id:
            self._remember_old(self._nested_sessions, session_id)

    def _parent_session_id(self, meta: Mapping[str, Any]) -> str:
        parent = meta.get("parent_session_id", meta.get("parentSessionId", _MISSING))
        return "" if parent is _MISSING or parent is None else str(parent).strip()

    def _is_delegated(self) -> bool | None:
        try:
            value = self._delegated_context()
            return None if value is None else bool(value)
        except Exception:
            return None

    def _cwd_for(self, meta: Mapping[str, Any], platform: str) -> str | None:
        explicit = _bounded(meta.get("cwd"), 4096)
        if explicit:
            return explicit
        try:
            cwd = self._get_cwd() if self._get_cwd is not None else self._default_cwd(platform)
            return _bounded(str(cwd), 4096) if cwd else None
        except Exception:
            return None

    def _new_root(
        self,
        session_id: str,
        platform: str,
        cwd: str,
        conversation_id: str | None = None,
        *,
        reporting_id: str | None = None,
    ) -> "_RootSession | None":
        if platform not in ROOT_PLATFORMS or not cwd:
            return None
        root = _RootSession(
            session_id=session_id,
            reporting_id=reporting_id or session_id,
            platform=platform,
            cwd=cwd,
            conversation_id=conversation_id,
        )
        self._remember_root(root)
        self._opened_sessions.pop(session_id, None)
        return root

    def _trusted_root(
        self,
        meta: Mapping[str, Any],
        *,
        allow_conversation: bool = False,
    ) -> tuple["_RootSession | None", bool]:
        delegated = self._is_delegated()
        if delegated is not False:
            return None, False
        self._mark_nested(meta)
        if self._parent_session_id(meta):
            return None, False
        session_id = self._session_id(meta)
        if not session_id or session_id in self._nested_sessions:
            return None, False
        conversation_id = self._conversation_id(meta)
        root = self._root_sessions.get(session_id)
        if root is not None:
            if conversation_id and root.conversation_id and conversation_id != root.conversation_id:
                self._remember_old(self._nested_sessions, session_id)
                return None, False
            if conversation_id and not root.conversation_id:
                root.conversation_id = conversation_id
                self._remember_root(root)
            return root, False
        if allow_conversation and conversation_id:
            mapped = self._root_by_conversation.get(conversation_id)
            previous = self._root_sessions.get(mapped or "")
            if previous is not None:
                cwd = self._cwd_for(meta, previous.platform) or previous.cwd
                root = self._new_root(
                    session_id,
                    previous.platform,
                    cwd,
                    conversation_id,
                    reporting_id=previous.reporting_id,
                )
                if root is not None:
                    self._root_sessions.pop(previous.session_id, None)
                    self._active.discard(previous.session_id)
                    self._waiting.pop(previous.session_id, None)
                    return root, previous.session_id != session_id
        return None, False

    def _prove_llm_root(self, meta: Mapping[str, Any]) -> "_RootSession | None":
        self._mark_nested(meta)
        if self._is_delegated() is not False:
            return None
        session_id = self._session_id(meta)
        platform = str(meta.get("platform") or "").strip().lower()
        parent = meta.get("parent_session_id", _MISSING)
        if (
            not session_id
            or parent is _MISSING
            or str(parent).strip()
            or platform not in ROOT_PLATFORMS
        ):
            return None
        root, _ = self._trusted_root(meta)
        if root is not None:
            return root
        if self._opened_sessions.get(session_id) != platform:
            return None
        cwd = self._cwd_for(meta, platform)
        return self._new_root(session_id, platform, cwd or "")

    def _payload(
        self,
        root: "_RootSession",
        event: str,
        state: str,
        tool: Mapping[str, str] | None = None,
    ) -> dict[str, Any] | None:
        if event not in EVENTS or state not in STATES:
            return None
        stamp = self._monotonic_ns()
        if not isinstance(stamp, int) or stamp < 0 or len(str(stamp)) > 32:
            return None
        pane_id = _bounded(self._environ.get("WINMUX_PANE_ID"), 128)
        payload: dict[str, Any] = {
            "agentId": "hermes",
            "event": event,
            "sessionId": root.reporting_id,
            "cwd": root.cwd,
            **({"paneId": pane_id} if pane_id else {}),
            "pid": self._get_pid(),
            "stamp": str(stamp),
            "state": state,
        }
        if tool is not None:
            tool_name = _bounded(tool.get("toolName"), 128)
            tool_id = _bounded(tool.get("toolId"), 256)
            phase = tool.get("phase")
            if (
                event not in {"tool_execution_start", "tool_execution_end"}
                or not tool_name
                or not tool_id
                or phase not in {"start", "end"}
            ):
                return None
            payload.update(toolName=tool_name, toolId=tool_id, phase=phase)
        return payload

    def _delivery_loop(self) -> None:
        assert self._queue is not None
        while True:
            payload = self._queue.get()
            try:
                if payload is None:
                    return
                try:
                    self._send(payload)
                except Exception:
                    pass
            finally:
                self._queue.task_done()

    def _emit(
        self,
        root: "_RootSession",
        event: str,
        state: str,
        tool: Mapping[str, str] | None = None,
    ) -> bool:
        payload = self._payload(root, event, state, tool=tool)
        if payload is None:
            return False
        if self._async:
            assert self._queue is not None
            try:
                self._queue.put_nowait(payload)
            except queue.Full:
                return False
        else:
            try:
                self._send(payload)
            except Exception:
                return False
        return True

    def _state(self, root_key: str, active_fallback: str = "running") -> str:
        return "waiting" if self._waiting.get(root_key) else (
            active_fallback if root_key in self._active else "idle"
        )

    def on_session_open(self, session_id: str = "", platform: str = "", reason: str = "", **meta: Any) -> None:
        del meta
        if reason not in {"create", "resume"}:
            return
        session_id = _bounded(session_id, 128) or ""
        platform = str(platform or "").strip().lower()
        if not session_id or platform not in ROOT_PLATFORMS:
            return
        with self._lock:
            # Open is the only root-candidate source. It becomes trusted only after
            # pre_llm_call confirms an empty parent and no delegated context.
            self._remember(self._opened_sessions, session_id, platform)

    def on_session_reset(
        self,
        session_id: str = "",
        platform: str = "",
        reason: str = "",
        old_session_id: str = "",
        new_session_id: str = "",
        **meta: Any,
    ) -> None:
        selected = new_session_id or session_id
        old_session_id = old_session_id or self._parent_session_id(meta)
        platform = str(platform or "").strip().lower()
        with self._lock:
            selected = _bounded(selected, 128) or ""
            old_session_id = _bounded(old_session_id, 128) or ""
            if not selected or platform not in ROOT_PLATFORMS:
                return
            previous = self._root_sessions.get(old_session_id)
            if previous is None:
                return
            root = self._new_root(
                selected,
                previous.platform,
                previous.cwd,
                previous.conversation_id,
                reporting_id=previous.reporting_id,
            )
            if root is None:
                return
            self._root_sessions.pop(old_session_id, None)
            self._active.discard(old_session_id)
            self._waiting.pop(old_session_id, None)
            root.session_started = True
            self._emit(root, "session_switch", "idle")

    def on_session_finalize(self, session_id: str = "", platform: str = "", **meta: Any) -> None:
        event = dict(meta, session_id=session_id, platform=platform)
        with self._lock:
            root, _ = self._trusted_root(event)
            if root is None:
                return
            if self._emit(root, "session_shutdown", "idle"):
                self._forget_root(root.session_id)

    def pre_llm_call(
        self,
        session_id: str = "",
        parent_session_id: Any = _MISSING,
        platform: Any = _MISSING,
        **meta: Any,
    ) -> None:
        event = dict(
            meta,
            session_id=session_id,
            parent_session_id=parent_session_id,
            platform=platform,
        )
        with self._lock:
            root = self._prove_llm_root(event)
            if root is None:
                return
            if not root.session_started:
                root.session_started = True
                self._emit(root, "session_start", "idle")
            self._active.add(root.session_id)
            self._emit(root, "agent_start", "running")

    def on_session_end(
        self,
        session_id: str = "",
        completed: bool = False,
        failed: bool = False,
        interrupted: bool = False,
        **meta: Any,
    ) -> None:
        event = dict(meta, session_id=session_id)
        with self._lock:
            root, _ = self._trusted_root(event)
            if root is None:
                return
            self._active.discard(root.session_id)
            self._waiting.pop(root.session_id, None)
            state = "failed" if failed else "completed" if completed else "idle" if interrupted else "idle"
            self._emit(root, "agent_end", state)

    def pre_tool_call(self, tool_name: str = "", tool_call_id: str = "", session_id: str = "", **meta: Any) -> None:
        event = dict(meta, session_id=session_id)
        with self._lock:
            root, switched = self._trusted_root(event, allow_conversation=True)
            if root is None:
                return
            if switched:
                root.session_started = True
                self._emit(root, "session_switch", "idle")
            self._active.add(root.session_id)
            self._emit(
                root,
                "tool_execution_start",
                self._state(root.session_id),
                tool={"toolName": tool_name, "toolId": tool_call_id, "phase": "start"},
            )

    def post_tool_call(self, tool_name: str = "", tool_call_id: str = "", session_id: str = "", **meta: Any) -> None:
        event = dict(meta, session_id=session_id)
        with self._lock:
            root, switched = self._trusted_root(event, allow_conversation=True)
            if root is None:
                return
            if switched:
                root.session_started = True
                self._emit(root, "session_switch", "idle")
            self._emit(
                root,
                "tool_execution_end",
                self._state(root.session_id),
                tool={"toolName": tool_name, "toolId": tool_call_id, "phase": "end"},
            )

    def subagent_start(self, child_session_id: str = "", **meta: Any) -> None:
        del meta
        session_id = _bounded(child_session_id, 128)
        if session_id:
            with self._lock:
                self._remember_old(self._nested_sessions, session_id)

    def subagent_stop(self, child_session_id: str = "", **meta: Any) -> None:
        del meta
        session_id = _bounded(child_session_id, 128)
        if session_id:
            with self._lock:
                self._remember_old(self._nested_sessions, session_id)

    def on_human_input_request(
        self,
        kind: str = "",
        request_id: str = "",
        session_id: str = "",
        **meta: Any,
    ) -> None:
        if kind not in {"approval", "sudo"} or not _bounded(request_id, 128):
            return
        event = dict(meta, session_id=session_id, kind=kind)
        with self._lock:
            root, switched = self._trusted_root(event, allow_conversation=True)
            if root is None:
                return
            if switched:
                root.session_started = True
                self._emit(root, "session_switch", "idle")
            self._waiting.setdefault(root.session_id, set()).add(request_id)
            self._emit(root, "tool_approval_requested", "waiting")

    def on_human_input_resolved(
        self,
        kind: str = "",
        request_id: str = "",
        session_id: str = "",
        outcome: str = "",
        **meta: Any,
    ) -> None:
        del outcome
        if kind not in {"approval", "sudo"} or not _bounded(request_id, 128):
            return
        event = dict(meta, session_id=session_id, kind=kind)
        with self._lock:
            root, switched = self._trusted_root(event, allow_conversation=True)
            if root is None:
                return
            if switched:
                root.session_started = True
                self._emit(root, "session_switch", "idle")
            waits = self._waiting.get(root.session_id)
            if waits is not None:
                waits.discard(request_id)
                if not waits:
                    self._waiting.pop(root.session_id, None)
            self._emit(root, "tool_approval_resolved", self._state(root.session_id))

    def register(self, ctx: Any) -> None:
        if ctx is None or not callable(getattr(ctx, "register_hook", None)):
            raise TypeError("Winmux Hermes plugin requires PluginContext.register_hook")
        for name in (
            "on_session_open",
            "on_session_reset",
            "on_session_finalize",
            "pre_llm_call",
            "pre_tool_call",
            "post_tool_call",
            "on_session_end",
            "subagent_start",
            "subagent_stop",
            "on_human_input_request",
            "on_human_input_resolved",
        ):
            ctx.register_hook(name, getattr(self, name))

    def close(self) -> None:
        if self._queue is not None:
            try:
                self._queue.put_nowait(None)
            except queue.Full:
                pass


def register(ctx: Any) -> None:
    WinmuxHermesPlugin().register(ctx)
