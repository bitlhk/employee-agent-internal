"""Run with the installed Jiuwen Python and the local runtime constraints.

Exercise real file operations/locks, rather than accepting copied files as proof
that a runtime can load them. All contents live in disposable directories.
"""
import asyncio
import faulthandler
from pathlib import Path
import tempfile
import unittest

from openjiuwen.core.sys_operation.base import OperationMode
from openjiuwen.core.sys_operation.config import LocalWorkConfig
from openjiuwen.core.sys_operation.local.fs_operation import FsOperation
from openjiuwen.core.sys_operation.local._rw_lock_manager import ReadWriteLockManager


class RuntimeSkillReadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="ea-skill-read-test-")
        self.root = Path(self.home.name)
        self.fs = FsOperation("fs", OperationMode.LOCAL, "skill read regression", LocalWorkConfig())

    async def asyncTearDown(self):
        await ReadWriteLockManager.stop()
        self.home.cleanup()

    async def test_startup_and_skill_files_can_be_read_repeatedly(self):
        for name in ("AGENT.md", "skills/scheduling-assistant/SKILL.md"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("# 日程协同\n只查询本人日程。\n", encoding="utf-8")
            for _ in range(2):
                result = await asyncio.wait_for(self.fs.read_file(str(target)), 3)
                self.assertEqual(result.code, 0, result.message)
                self.assertEqual(result.data.content, target.read_text(encoding="utf-8"))

    async def test_shared_readers_still_block_a_writer_and_release(self):
        target = self.root / "SKILL.md"
        target.write_text("fixture", encoding="utf-8")
        entered = asyncio.Queue()
        release_readers = asyncio.Event()
        writer_entered = asyncio.Event()

        async def reader():
            async with ReadWriteLockManager.lock_guard(target, "read", 3):
                await entered.put(True)
                await release_readers.wait()

        async def writer():
            async with ReadWriteLockManager.lock_guard(target, "write", 3):
                writer_entered.set()

        first, second = asyncio.create_task(reader()), asyncio.create_task(reader())
        await asyncio.wait_for(entered.get(), 3)
        await asyncio.wait_for(entered.get(), 3)
        writing = asyncio.create_task(writer())
        await asyncio.sleep(0.05)
        self.assertFalse(writer_entered.is_set())
        release_readers.set()
        await asyncio.wait_for(asyncio.gather(first, second, writing), 3)
        self.assertTrue(writer_entered.is_set())


if __name__ == "__main__":
    faulthandler.dump_traceback_later(20, exit=True)
    try:
        unittest.main()
    finally:
        faulthandler.cancel_dump_traceback_later()
