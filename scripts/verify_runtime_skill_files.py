"""Check an actual demo workspace through the installed runtime file operations."""
import asyncio
from pathlib import Path
import sys
from openjiuwen.core.sys_operation.base import OperationMode
from openjiuwen.core.sys_operation.config import LocalWorkConfig
from openjiuwen.core.sys_operation.local.fs_operation import FsOperation
from openjiuwen.core.sys_operation.local._rw_lock_manager import ReadWriteLockManager


async def main():
    workspace = Path(sys.argv[1]).resolve()
    assert workspace.is_dir()
    fs = FsOperation("fs", OperationMode.LOCAL, "demo skill verification", LocalWorkConfig())
    try:
        result = await asyncio.wait_for(fs.list_directories(str(workspace / "skills")), 5)
        assert result.code == 0, result.message
        assert "scheduling-assistant" in result.model_dump_json()
        result = await asyncio.wait_for(fs.list_files(str(workspace / "skills/scheduling-assistant")), 5)
        assert result.code == 0, result.message
        assert "SKILL.md" in result.model_dump_json()
        result = await asyncio.wait_for(fs.read_file(str(workspace / "skills/scheduling-assistant/SKILL.md")), 5)
        assert result.code == 0, result.message
        assert "# 日程协同" in result.data.content
        print("EA_SKILL_FILES_OK")
    finally:
        await ReadWriteLockManager.stop()


asyncio.run(main())
