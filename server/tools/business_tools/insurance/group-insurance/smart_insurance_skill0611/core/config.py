"""
Smart Insurance Skill 0611 - 配置管理模块

支持YAML配置文件加载、MCP服务器配置管理
"""

import os
import yaml
from typing import Dict, Any, Optional
from pathlib import Path


class SkillConfig:
    """
    Smart Insurance Skill 配置管理类

    支持多种配置加载方式:
    - YAML文件加载
    - 字典直接配置
    - 环境变量覆盖

    使用示例:
        # 从YAML文件加载
        config = SkillConfig.from_yaml('config.yaml')

        # 从字典创建
        config = SkillConfig.from_dict({
            'mcp': {'server_url': 'http://mcp-server:8080'},
            'vision': {'provider': 'maas'},
            'llm': {'default_provider': 'maas'}
        })

        # 获取配置
        vision_config = config.get_section('vision')
        llm_model = config.get('llm.default_provider')
    """

    def __init__(self, config_dict: Dict[str, Any]):
        """
        初始化配置

        Args:
            config_dict: 配置字典
        """
        self._config = config_dict or {}
        self._validate_config()

    def _validate_config(self) -> None:
        """验证配置基本结构"""
        required_sections = ['mcp', 'vision', 'llm']
        for section in required_sections:
            if section not in self._config:
                self._config[section] = {}

        # 验证MCP服务器配置
        if 'server_url' not in self._config['mcp']:
            # 尝试从环境变量获取
            mcp_url = os.getenv('MCP_SERVER_URL', 'http://localhost:8080')
            self._config['mcp']['server_url'] = mcp_url

    @classmethod
    def from_yaml(cls, yaml_path: str) -> 'SkillConfig':
        """
        从YAML文件加载配置

        Args:
            yaml_path: YAML文件路径

        Returns:
            SkillConfig实例

        Raises:
            FileNotFoundError: 文件不存在
            yaml.YAMLError: YAML解析错误
        """
        path = Path(yaml_path)
        if not path.exists():
            raise FileNotFoundError(f"配置文件不存在: {yaml_path}")

        with open(path, 'r', encoding='utf-8') as f:
            config_dict = yaml.safe_load(f) or {}

        return cls(config_dict)

    @classmethod
    def from_dict(cls, config_dict: Dict[str, Any]) -> 'SkillConfig':
        """
        从字典创建配置

        Args:
            config_dict: 配置字典

        Returns:
            SkillConfig实例
        """
        return cls(config_dict)

    @classmethod
    def from_env(cls) -> 'SkillConfig':
        """
        从环境变量加载配置

        支持的环境变量:
        - MCP_SERVER_URL: MCP服务器地址
        - SMART_INSURANCE_VISION_PROVIDER: 多模态服务商
        - SMART_INSURANCE_LLM_PROVIDER: LLM服务商
        - SMART_INSURANCE_LLM_API_KEY: API密钥
        - SMART_INSURANCE_LLM_API_URL: API地址

        Returns:
            SkillConfig实例
        """
        config_dict = {
            'mcp': {
                'server_url': os.getenv('MCP_SERVER_URL', 'http://localhost:8080'),
                'timeout': int(os.getenv('MCP_TIMEOUT', '30')),
                'retry_times': int(os.getenv('MCP_RETRY_TIMES', '3')),
            },
            'vision': {
                'provider': os.getenv('SMART_INSURANCE_VISION_PROVIDER', 'maas'),
                'max_concurrency': int(os.getenv('VISION_MAX_CONCURRENCY', '5')),
            },
            'llm': {
                'default_provider': os.getenv('SMART_INSURANCE_LLM_PROVIDER', 'maas'),
                'maas': {
                    'api_url': os.getenv('SMART_INSURANCE_LLM_API_URL', ''),
                    'api_key': os.getenv('SMART_INSURANCE_LLM_API_KEY', ''),
                }
            }
        }
        return cls(config_dict)

    def get(self, key: str, default: Any = None) -> Any:
        """
        获取配置值（支持嵌套键）

        Args:
            key: 配置键，支持点分隔的嵌套键（如 'llm.maas.api_url')
            default: 默认值

        Returns:
            配置值
        """
        keys = key.split('.')
        value = self._config

        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default

        return value

    def get_section(self, section: str) -> Dict[str, Any]:
        """
        获取配置区块

        Args:
            section: 区块名称

        Returns:
            配置字典
        """
        return self._config.get(section, {})

    def get_mcp_config(self) -> Dict[str, Any]:
        """获取MCP配置"""
        return self.get_section('mcp')

    def get_vision_config(self) -> Dict[str, Any]:
        """获取多模态配置"""
        return self.get_section('vision')

    def get_llm_config(self) -> Dict[str, Any]:
        """获取LLM配置"""
        return self.get_section('llm')

    def get_pipeline_config(self) -> Dict[str, Any]:
        """获取Pipeline配置"""
        return self.get_section('pipeline')

    def get_template_config(self) -> Dict[str, Any]:
        """获取模板配置"""
        return self.get_section('templates')

    def get_storage_config(self) -> Dict[str, Any]:
        """获取存储配置"""
        return self.get_section('storage')

    def set(self, key: str, value: Any) -> None:
        """
        设置配置值

        Args:
            key: 配置键
            value: 配置值
        """
        keys = key.split('.')
        config = self._config

        for k in keys[:-1]:
            if k not in config:
                config[k] = {}
            config = config[k]

        config[keys[-1]] = value

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return self._config.copy()

    def merge(self, other_config: Dict[str, Any]) -> 'SkillConfig':
        """
        合并配置

        Args:
            other_config: 其他配置字典

        Returns:
            新的SkillConfig实例
        """
        merged = self._deep_merge(self._config, other_config)
        return SkillConfig(merged)

    def _deep_merge(self, base: Dict, override: Dict) -> Dict:
        """深度合并字典"""
        result = base.copy()
        for key, value in override.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = self._deep_merge(result[key], value)
            else:
                result[key] = value
        return result

    def save(self, yaml_path: str) -> None:
        """
        保存配置到YAML文件

        Args:
            yaml_path: YAML文件路径
        """
        path = Path(yaml_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, 'w', encoding='utf-8') as f:
            yaml.dump(self._config, f, allow_unicode=True, default_flow_style=False)

    def __repr__(self) -> str:
        return f"SkillConfig(sections={list(self._config.keys())})"


def load_config(config_path: Optional[str] = None) -> SkillConfig:
    """
    快捷函数：加载配置

    Args:
        config_path: 配置文件路径，如果为None则尝试默认路径

    Returns:
        SkillConfig实例
    """
    if config_path:
        return SkillConfig.from_yaml(config_path)

    # 尝试默认路径
    default_paths = ['config.yaml', 'config.yml', './config/config.yaml']
    for path in default_paths:
        if os.path.exists(path):
            return SkillConfig.from_yaml(path)

    # 使用环境变量或默认配置
    return SkillConfig.from_env()
