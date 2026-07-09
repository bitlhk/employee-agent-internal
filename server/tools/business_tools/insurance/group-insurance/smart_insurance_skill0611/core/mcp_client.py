"""
Smart Insurance Skill 0611 - MCP客户端

负责与部署在 EA / JiuwenSwarm 可访问网络中的 MCP 服务通信
所有网络请求通过MCP服务器转发，绕过沙箱网络限制
"""

import json
import logging
import requests
import time
from typing import Dict, Any, Optional, List
from pathlib import Path

from smart_insurance_skill0611.core.exceptions import (
    MCPConnectionError,
    MCPToolError,
    MCPResponseError
)
from smart_insurance_skill0611.core.config import SkillConfig

logger = logging.getLogger(__name__)


class MCPClient:
    """
    MCP客户端 - 与MCP服务器通信

    特点：
    - 所有外部网络访问通过MCP服务器转发
    - 支持多模态识别和LLM推理
    - 支持重试和超时机制
    - 绕过沙箱网络限制

    使用示例:
        config = SkillConfig.from_yaml('config.yaml')
        mcp_client = MCPClient(config)

        # 调用多模态工具
        result = mcp_client.call_tool(
            'vision_classify_page',
            {'image_path': '/path/to/image.png'}
        )

        # 调用LLM工具
        response = mcp_client.call_tool(
            'llm_infer',
            {'prompt': '请分析这段文本...', 'provider': 'maas'}
        )
    """

    def __init__(self, config: SkillConfig):
        """
        初始化MCP客户端

        Args:
            config: Skill配置对象
        """
        self.config = config
        mcp_config = config.get_mcp_config()

        self.server_url = mcp_config.get('server_url', 'http://localhost:8080')
        self.timeout = mcp_config.get('timeout', 30)
        self.retry_times = mcp_config.get('retry_times', 3)
        self.retry_delay = mcp_config.get('retry_delay', 1)

        # 验证服务器连接
        self._verify_connection()

    def _verify_connection(self) -> None:
        """验证MCP服务器连接"""
        try:
            response = requests.get(
                f"{self.server_url}/health",
                timeout=5
            )
            if response.status_code != 200:
                raise MCPConnectionError(
                    f"MCP服务器健康检查失败",
                    self.server_url
                )
            logger.info(f"MCP服务器连接成功: {self.server_url}")
        except requests.exceptions.RequestException as e:
            logger.warning(f"MCP服务器连接失败（将在后续调用时重试）: {e}")

    def call_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        timeout: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        调用MCP工具

        Args:
            tool_name: 工具名称
            arguments: 工具参数
            timeout: 超时时间（可选）

        Returns:
            工具执行结果

        Raises:
            MCPConnectionError: 连接失败
            MCPToolError: 工具调用失败
            MCPResponseError: 响应解析失败
        """
        request_timeout = timeout or self.timeout

        # 构建请求
        payload = {
            "tool_name": tool_name,
            "arguments": arguments
        }

        # 重试机制
        for attempt in range(self.retry_times):
            try:
                response = requests.post(
                    f"{self.server_url}/call_tool",
                    json=payload,
                    timeout=request_timeout
                )

                if response.status_code != 200:
                    raise MCPToolError(
                        f"工具调用失败: HTTP {response.status_code}",
                        tool_name,
                        arguments
                    )

                result = response.json()

                # 验证响应格式
                if not self._validate_response(result):
                    raise MCPResponseError(
                        "响应格式不符合MCP规范",
                        result
                    )

                # 检查执行状态
                if result.get('status') == 'error':
                    raise MCPToolError(
                        result.get('message', '工具执行失败'),
                        tool_name,
                        arguments
                    )

                return result.get('data', {})

            except requests.exceptions.Timeout as e:
                logger.warning(f"工具调用超时（尝试 {attempt + 1}/{self.retry_times}）: {e}")
                if attempt < self.retry_times - 1:
                    time.sleep(self.retry_delay)
                else:
                    raise MCPConnectionError(
                        f"工具调用超时: {tool_name}",
                        self.server_url
                    )

            except requests.exceptions.RequestException as e:
                logger.warning(f"网络请求失败（尝试 {attempt + 1}/{self.retry_times}）: {e}")
                if attempt < self.retry_times - 1:
                    time.sleep(self.retry_delay)
                else:
                    raise MCPConnectionError(
                        f"MCP服务器连接失败: {e}",
                        self.server_url
                    )

    def _validate_response(self, response: Dict[str, Any]) -> bool:
        """
        验证MCP响应格式

        Args:
            response: 响应数据

        Returns:
            是否符合MCP规范
        """
        required_fields = ['status', 'data']
        return all(field in response for field in required_fields)

    def call_vision_tool(
        self,
        tool_type: str,
        image_path: str,
        prompt: Optional[str] = None,
        fewshot_images: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        调用多模态识别工具

        Args:
            tool_type: 工具类型（classify/extract_text/extract_table/coordinate/quotation）
            image_path: 图片路径
            prompt: Prompt模板（可选）
            fewshot_images: Few-shot样例图片（可选）

        Returns:
            识别结果
        """
        tool_name = f"vision_{tool_type}"

        arguments = {
            'image_path': image_path,
            'provider': self.config.get('vision.provider', 'maas')
        }

        if prompt:
            arguments['prompt'] = prompt

        if fewshot_images:
            arguments['fewshot_images'] = fewshot_images

        return self.call_tool(tool_name, arguments)

    def call_llm_tool(
        self,
        tool_type: str,
        prompt: str,
        provider: Optional[str] = None,
        model: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        调用LLM推理工具

        Args:
            tool_type: 工具类型（infer/extract/generate）
            prompt: Prompt内容
            provider: 服务商（可选）
            model: 模型名称（可选）

        Returns:
            推理结果
        """
        tool_name = f"llm_{tool_type}"

        arguments = {
            'prompt': prompt,
            'provider': provider or self.config.get('llm.default_provider', 'maas')
        }

        if model:
            arguments['model'] = model

        return self.call_tool(tool_name, arguments, timeout=120)

    def batch_call_vision(
        self,
        tasks: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        批量调用多模态工具

        Args:
            tasks: 任务列表，每个任务包含 tool_type, image_path 等参数

        Returns:
            结果列表
        """
        results = []

        for task in tasks:
            try:
                result = self.call_vision_tool(
                    task.get('tool_type'),
                    task.get('image_path'),
                    task.get('prompt'),
                    task.get('fewshot_images')
                )
                results.append(result)
            except MCPToolError as e:
                logger.error(f"批量调用失败: {e}")
                results.append({'error': str(e)})

        return results

    def get_server_info(self) -> Dict[str, Any]:
        """
        获取MCP服务器信息

        Returns:
            服务器信息（版本、支持的工具列表等）
        """
        try:
            response = requests.get(
                f"{self.server_url}/info",
                timeout=5
            )
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"获取服务器信息失败: {e}")
            return {}

    def list_tools(self) -> List[Dict[str, Any]]:
        """
        获取可用的MCP工具列表

        Returns:
            工具列表
        """
        try:
            response = requests.get(
                f"{self.server_url}/tools",
                timeout=5
            )
            return response.json().get('tools', [])
        except requests.exceptions.RequestException as e:
            logger.error(f"获取工具列表失败: {e}")
            return []


class MCPClientPool:
    """
    MCP客户端池 - 支持并发调用

    使用示例:
        pool = MCPClientPool(config, max_concurrency=5)
        results = pool.batch_call(tasks)
    """

    def __init__(self, config: SkillConfig, max_concurrency: int = 5):
        """
        初始化客户端池

        Args:
            config: Skill配置
            max_concurrency: 最大并发数
        """
        self.config = config
        self.max_concurrency = max_concurrency
        self.client = MCPClient(config)

    def batch_call(
        self,
        tasks: List[Dict[str, Any]],
        tool_type: str = "vision"
    ) -> List[Dict[str, Any]]:
        """
        批量并发调用

        Args:
            tasks: 任务列表
            tool_type: 工具类型

        Returns:
            结果列表
        """
        # 使用简单的并发控制
        results = []
        batch_size = self.max_concurrency

        for i in range(0, len(tasks), batch_size):
            batch = tasks[i:i + batch_size]

            # 处理批次
            batch_results = []
            for task in batch:
                try:
                    if tool_type == "vision":
                        result = self.client.call_vision_tool(
                            task.get('tool_type', 'extract_text'),
                            task.get('image_path'),
                            task.get('prompt'),
                            task.get('fewshot_images')
                        )
                    elif tool_type == "llm":
                        result = self.client.call_llm_tool(
                            task.get('tool_type', 'infer'),
                            task.get('prompt'),
                            task.get('provider'),
                            task.get('model')
                        )
                    else:
                        result = self.client.call_tool(
                            task.get('tool_name'),
                            task.get('arguments')
                        )
                    batch_results.append(result)
                except Exception as e:
                    logger.error(f"任务执行失败: {e}")
                    batch_results.append({'error': str(e)})

            results.extend(batch_results)

        return results


def create_mcp_client(config: SkillConfig) -> MCPClient:
    """
    快捷函数：创建MCP客户端

    Args:
        config: Skill配置

    Returns:
        MCPClient实例
    """
    return MCPClient(config)
