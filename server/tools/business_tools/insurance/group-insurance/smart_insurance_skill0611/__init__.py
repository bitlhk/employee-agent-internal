"""
Smart Insurance Skill 0611 - 基于MCP的保险团单解读框架

特点：
- 部署在沙箱环境，通过MCP服务间接访问外部网络
- 所有LLM/多模态调用通过MCP服务器转发
- 完整的端到端保险文档解读流程

版本: 1.0.0
"""

__version__ = "1.0.0"
__author__ = "Smart Insurance Team"

from smart_insurance_skill0611.core.config import SkillConfig
from smart_insurance_skill0611.pipeline.e2e_pipeline import E2EPipeline

def create_pipeline(config_path: str = None) -> E2EPipeline:
    """
    创建E2E Pipeline实例

    Args:
        config_path: 配置文件路径，默认使用config.yaml

    Returns:
        E2EPipeline实例
    """
    config = SkillConfig.from_yaml(config_path or "config.yaml")
    return E2EPipeline(config)


def run_insurance_reading(
    pdf_path: str,
    images: list,
    task_id: str,
    config_path: str = None,
    mcp_server_url: str = None
) -> dict:
    """
    快捷函数：执行保险团单解读

    Args:
        pdf_path: PDF文件路径
        images: 报价单图片路径列表
        task_id: 任务ID
        config_path: 配置文件路径
        mcp_server_url: MCP服务器地址（如: http://mcp-server:8080）

    Returns:
        解读结果JSON
    """
    pipeline = create_pipeline(config_path)
    return pipeline.run({
        'pdf_path': pdf_path,
        'images': images,
        'task_id': task_id,
        'mcp_server_url': mcp_server_url
    })
