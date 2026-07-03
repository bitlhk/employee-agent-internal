"""
Smart Insurance Skill 0611 - 多模态识别工具

封装所有多模态识别相关的MCP工具调用
包括页面分类、文本抽取、表格抽取、坐标定位等
"""

import logging
from typing import Dict, Any, Optional, List
from pathlib import Path

from smart_insurance_skill0611.core.mcp_client import MCPClient
from smart_insurance_skill0611.core.exceptions import MCPToolError

logger = logging.getLogger(__name__)


class VisionTool:
    """
    多模态识别工具 - 通过MCP调用多模态服务

    功能：
    - 页面分类（识别保险责任表单页）
    - 文本抽取（从图片中抽取文本）
    - 表格抽取（从图片中抽取表格数据）
    - 坐标定位（定位文本坐标位置）
    - 报价单提取（从报价单图片中提取信息）

    使用示例:
        mcp_client = MCPClient(config)
        vision_tool = VisionTool(mcp_client)

        # 页面分类
        is_form_page = vision_tool.classify_page('/path/to/image.png')

        # 文本抽取
        text = vision_tool.extract_text('/path/to/image.png', prompt)

        # 表格抽取
        table_data = vision_tool.extract_table('/path/to/image.png')
    """

    # 工具类型映射
    TOOL_TYPES = {
        'classify': 'vision_classify_page',
        'extract_text': 'vision_extract_text',
        'extract_table': 'vision_extract_table',
        'coordinate': 'vision_extract_coordinate',
        'quotation': 'vision_extract_quotation'
    }

    def __init__(self, mcp_client: MCPClient, provider: str = 'maas'):
        """
        初始化多模态工具

        Args:
            mcp_client: MCP客户端
            provider: 服务商（maas/aliyun/openai/custom）
        """
        self.mcp_client = mcp_client
        self.provider = provider

        # Few-shot图片路径（可选）
        self._fewshot_images: Dict[str, str] = {}

    def set_fewshot_images(self, fewshot_dir: str) -> None:
        """
        设置Few-shot样例图片目录

        Args:
            fewshot_dir: Few-shot图片目录路径
        """
        fewshot_path = Path(fewshot_dir)

        self._fewshot_images = {
            'coordinate': str(fewshot_path / 'fewshot_coordinate_LL_P15.png'),
            'table': str(fewshot_path / 'fewshot_extract_table_DG_merge_P31_P12.png')
        }

        logger.info(f"Few-shot图片设置完成: {fewshot_dir}")

    def classify_page(
        self,
        image_path: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        页面分类 - 判断是否为保险责任表单页

        Args:
            image_path: 图片路径
            prompt: 自定义Prompt（可选）

        Returns:
            分类结果:
            {
                'is_form_page': True/False,
                'confidence': 0.95,
                'raw_response': '<result><保险责任表单页></result>'
            }
        """
        default_prompt = """请从图片<image>中识别出<保险责任表单页>，在<result>tag里。要求：
1. <保险责任表单页>包含"保险责任","保险金额","交费标准","约定项","约定值"字段。字段为黑色加粗字体。
2. 结论放在<result>tag里。
3. 参考样例：<result><保险责任表单页></result>或<result><非保险责任表单页></result>
4. 禁止输出<result>之外的其他信息"""

        result = self.mcp_client.call_vision_tool(
            'classify',
            image_path,
            prompt or default_prompt
        )

        # 解析结果
        raw_response = result.get('text', '')
        is_form_page = '<保险责任表单页>' in raw_response

        return {
            'is_form_page': is_form_page,
            'confidence': result.get('confidence', 0.0),
            'raw_response': raw_response,
            'image_path': image_path
        }

    def extract_text(
        self,
        image_path: str,
        prompt: Optional[str] = None,
        enable_page_tag: bool = True
    ) -> Dict[str, Any]:
        """
        文本抽取 - 从图片中抽取文本内容

        Args:
            image_path: 图片路径
            prompt: 自定义Prompt（可选）
            enable_page_tag: 是否生成<page>标签

        Returns:
            提取结果:
            {
                'text': '提取的文本内容',
                'page_number': 1,
                'page_tag': '<page01>...</page01>'
            }
        """
        default_prompt = """请从图片<image>中识别并提取文本信息，要求：
1. 保持原文格式和顺序
2. 识别表格中的文本内容
3. 保留特殊标记和符号
4. 如有标题，按层级结构输出"""

        result = self.mcp_client.call_vision_tool(
            'extract_text',
            image_path,
            prompt or default_prompt
        )

        text = result.get('text', '')

        # 添加page标签
        if enable_page_tag:
            page_number = result.get('page_number', 1)
            page_tag = f"<page{page_number:02d}>{text}</page{page_number:02d}>"
            return {
                'text': text,
                'page_number': page_number,
                'page_tag': page_tag,
                'image_path': image_path
            }

        return {
            'text': text,
            'page_number': result.get('page_number', 1),
            'image_path': image_path
        }

    def extract_table(
        self,
        image_path: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        表格抽取 - 从图片中抽取表格数据

        Args:
            image_path: 图片路径
            prompt: 自定义Prompt（可选）

        Returns:
            表格数据:
            {
                'headers': ['保险责任', '保险金额', '交费标准'],
                'rows': [
                    {'保险责任': '意外医疗', '保险金额': '10000', '交费标准': '50'},
                    ...
                ],
                'raw_table': '原始表格文本'
            }
        """
        default_prompt = """请从图片<image>中识别并提取表格数据，要求：
1. 识别表格标题行和所有数据行
2. 保持表格结构完整
3. 提取所有列的内容
4. 以JSON格式输出表格数据"""

        # 添加Few-shot样例
        fewshot = []
        if 'table' in self._fewshot_images:
            fewshot.append(self._fewshot_images['table'])

        result = self.mcp_client.call_vision_tool(
            'extract_table',
            image_path,
            prompt or default_prompt,
            fewshot_images=fewshot if fewshot else None
        )

        return {
            'headers': result.get('headers', []),
            'rows': result.get('rows', []),
            'raw_table': result.get('raw_table', ''),
            'image_path': image_path
        }

    def extract_coordinate(
        self,
        image_path: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        坐标定位 - 定位文本在图片中的坐标位置

        Args:
            image_path: 图片路径
            prompt: 自定义Prompt（可选）

        Returns:
            坐标数据:
            {
                'text': '定位的文本',
                'coordinates': [{'x': 100, 'y': 50, 'width': 200, 'height': 30}],
                'page_number': 1
            }
        """
        default_prompt = """请从图片<image>中识别文本并定位其坐标位置，要求：
1. 输出文本内容和对应的坐标框
2. 坐标格式：左上角(x,y)，宽(width)，高(height)
3. 标注页码信息"""

        # 添加Few-shot样例
        fewshot = []
        if 'coordinate' in self._fewshot_images:
            fewshot.append(self._fewshot_images['coordinate'])

        result = self.mcp_client.call_vision_tool(
            'coordinate',
            image_path,
            prompt or default_prompt,
            fewshot_images=fewshot if fewshot else None
        )

        return {
            'text': result.get('text', ''),
            'coordinates': result.get('coordinates', []),
            'page_number': result.get('page_number', 1),
            'image_path': image_path
        }

    def extract_quotation(
        self,
        image_path: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        报价单提取 - 从报价单图片中提取信息

        Args:
            image_path: 图片路径
            prompt: 自定义Prompt（可选）

        Returns:
            报价单数据:
            {
                'scheme_name': '方案A',
                'scheme_info': {...},
                'agreement': '特约内容',
                'hierarchy': {...}
            }
        """
        default_prompt = """请从报价单图片<image>中提取以下信息：
1. 方案名称和方案内容
2. 特约条款
3. 层级信息
4. 保险责任和金额
以结构化JSON格式输出"""

        result = self.mcp_client.call_vision_tool(
            'quotation',
            image_path,
            prompt or default_prompt
        )

        return {
            'scheme_name': result.get('scheme_name', ''),
            'scheme_info': result.get('scheme_info', {}),
            'agreement': result.get('agreement', ''),
            'hierarchy': result.get('hierarchy', {}),
            'image_path': image_path
        }

    def batch_process(
        self,
        image_paths: List[str],
        tool_type: str = 'extract_text',
        prompts: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """
        批量处理图片

        Args:
            image_paths: 图片路径列表
            tool_type: 工具类型
            prompts: Prompt列表（可选）

        Returns:
            结果列表
        """
        results = []

        for idx, image_path in enumerate(image_paths):
            prompt = prompts[idx] if prompts and idx < len(prompts) else None

            try:
                if tool_type == 'classify':
                    result = self.classify_page(image_path, prompt)
                elif tool_type == 'extract_text':
                    result = self.extract_text(image_path, prompt)
                elif tool_type == 'extract_table':
                    result = self.extract_table(image_path, prompt)
                elif tool_type == 'coordinate':
                    result = self.extract_coordinate(image_path, prompt)
                elif tool_type == 'quotation':
                    result = self.extract_quotation(image_path, prompt)
                else:
                    raise MCPToolError(f"未知工具类型: {tool_type}")

                results.append(result)

            except Exception as e:
                logger.error(f"图片处理失败: {image_path}, 错误: {e}")
                results.append({
                    'error': str(e),
                    'image_path': image_path
                })

        return results

    def filter_form_pages(
        self,
        image_paths: List[str]
    ) -> List[str]:
        """
        过滤出保险责任表单页图片

        Args:
            image_paths: 图片路径列表

        Returns:
            表单页图片路径列表
        """
        form_pages = []

        for image_path in image_paths:
            result = self.classify_page(image_path)
            if result.get('is_form_page'):
                form_pages.append(image_path)

        logger.info(f"筛选出{len(form_pages)}个表单页（共{len(image_paths)}页）")
        return form_pages