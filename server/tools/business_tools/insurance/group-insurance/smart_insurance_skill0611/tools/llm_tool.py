"""
Smart Insurance Skill 0611 - LLM推理工具

封装所有LLM推理相关的MCP工具调用
包括层级方案推理、基础信息提取、保险责任推理等
"""

import logging
from typing import Dict, Any, Optional, List

from smart_insurance_skill0611.core.mcp_client import MCPClient
from smart_insurance_skill0611.core.exceptions import MCPToolError, ExtractionError

logger = logging.getLogger(__name__)


class LLMTool:
    """
    LLM推理工具 - 通过MCP调用LLM服务

    功能：
    - 层级方案关系推理
    - 基础信息提取
    - 团单特约提取
    - 个人特约提取
    - 保险责任多轮推理

    使用示例:
        mcp_client = MCPClient(config)
        llm_tool = LLMTool(mcp_client)

        # 层级方案推理
        directory = llm_tool.infer_directory(contract_text)

        # 基础信息提取
        basic_info = llm_tool.extract_basic_info(contract_text, quotation_text)
    """

    def __init__(self, mcp_client: MCPClient, provider: str = 'maas'):
        """
        初始化LLM工具

        Args:
            mcp_client: MCP客户端
            provider: 服务商（maas/aliyun/openai/custom）
        """
        self.mcp_client = mcp_client
        self.provider = provider

        # Prompt模板缓存
        self._prompts: Dict[str, str] = {}

    def load_prompt_template(self, template_name: str, template_content: str) -> None:
        """
        加载Prompt模板

        Args:
            template_name: 模板名称
            template_content: 模板内容
        """
        self._prompts[template_name] = template_content
        logger.info(f"加载Prompt模板: {template_name}")

    def get_prompt(self, template_name: str) -> str:
        """
        获取Prompt模板

        Args:
            template_name: 模板名称

        Returns:
            模板内容
        """
        return self._prompts.get(template_name, '')

    def infer_directory(
        self,
        contract_text: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        层级方案关系推理

        Args:
            contract_text: 合同文本
            prompt: Prompt模板（可选）

        Returns:
            层级方案关系数据:
            {
                '方案名称': ['方案A', '方案B'],
                '方案序号': ['01', '02'],
                '层级': ['员工', '子女', '配偶'],
                '层级方案对应': [...]
            }
        """
        default_prompt = """《合同》的层级信息如下：
{合同层级部分输入}

请从《合同》的层级信息中提取层级与方案的对应关系，以JSON格式输出：
result = {
    "方案名称": ["方案A", "方案B"],
    "方案序号": ["01", "02"],
    "层级": ["员工", "子女", "配偶"],
    "层级方案对应": [
        {"层级": "员工", "对应方案": ["方案A", "方案B"]},
        {"层级": "子女", "对应方案": ["方案A"]}
    ]
}"""

        input_prompt = (prompt or default_prompt).replace('{合同层级部分输入}', contract_text)

        result = self.mcp_client.call_llm_tool(
            'infer',
            input_prompt,
            provider=self.provider
        )

        # 解析JSON结果
        response_text = result.get('text', '')

        return {
            'response': response_text,
            'parsed': self._parse_json(response_text),
            'raw_result': result
        }

    def extract_basic_info(
        self,
        contract_text: str,
        quotation_text: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        基础信息提取

        Args:
            contract_text: 合同文本
            quotation_text: 报价单文本
            prompt: Prompt模板（可选）

        Returns:
            基础信息:
            {
                '保单基本信息': {...},
                '团单特约': {...},
                '个人特约': [...],
                '其他特约': [...]
            }
        """
        default_prompt = """《合同》内容如下：
{合同输入}

《报价单》内容如下：
{报价单输入}

请从《合同》、《报价单》的内容中按照字段来源提取以下数据，提取时直接提取输入的原文文字，禁止归纳修改：

1. 基本信息，提取字段：投保单位名称，团单号，保险期间，等待期。字段来源：《合同》。
2. 团体特约，提取字段：既往症，是否持卡，特需就诊，职业类别，特殊计算，药量控制，门特/门慢的特殊规则。
3. 个人特约，提取字段：姓名，身份证号，个人特约。
4. 其他特约，提取字段：序号，特约内容。

严格按照以下格式要求，将提取到的信息输出为python的json结构化数据。"""

        input_prompt = (prompt or default_prompt).replace(
            '{合同输入}', contract_text
        ).replace(
            '{报价单输入}', quotation_text
        )

        result = self.mcp_client.call_llm_tool(
            'extract',
            input_prompt,
            provider=self.provider
        )

        response_text = result.get('text', '')

        return {
            'response': response_text,
            'parsed': self._parse_json(response_text),
            'raw_result': result
        }

    def extract_scheme_special(
        self,
        scheme_text: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        方案特约提取

        Args:
            scheme_text: 方案文本
            prompt: Prompt模板（可选）

        Returns:
            方案特约数据:
            {
                '方案特约': '方案特约原文内容'
            }
        """
        default_prompt = """《合同》的层级信息如下：
{合同层级部分输入}

从《合同》的层级信息中提取方案特约的原文描述内容，禁止修改、删减或省略，当层级信息中没有方案特约时填空字符串。

一、字段提取规则：

"方案特约"：数据来自《合同》的层级信息中"方案特约：XXXX"字段所在页，"XXXX"表示省略的全部方案特约内容，具体规则如下：
1 找到"方案特约："所在的<pageXX></pageXX>页；
2 提取"方案特约："所在的<pageXX></pageXX>页"方案特约："后面的全部特约描述的内容，提取数据直到原文内容出现</pageXX>截止；
3 任何针对各类医疗险，各类交通意外险的风险说明或责任描述均属于"方案特约"内容，禁止排除，省略；

按照以下格式要求输出python列表结构数据：

result = {
    "方案特约": "XXXX"
}"""

        input_prompt = (prompt or default_prompt).replace('{合同层级部分输入}', scheme_text)

        result = self.mcp_client.call_llm_tool(
            'extract',
            input_prompt,
            provider=self.provider
        )

        response_text = result.get('text', '')

        return {
            'response': response_text,
            'parsed': self._parse_json(response_text),
            'raw_result': result
        }

    def extract_liability(
        self,
        scheme_text: str,
        round_number: int = 1,
        previous_results: Optional[List[Dict]] = None,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        保险责任提取（支持多轮推理）

        Args:
            scheme_text: 方案文本
            round_number: 当前轮次
            previous_results: 前几轮的结果（可选）
            prompt: Prompt模板（可选）

        Returns:
            保险责任数据
        """
        default_prompt = """从方案文本中提取保险责任、保险金额、免赔额、赔付比例等信息：

方案文本：
{方案输入}

请提取以下字段：
- 保险责任
- 保险金额
- 免赔额
- 赔付比例
- 赔付限额

以JSON格式输出。"""

        input_prompt = (prompt or default_prompt).replace('{方案输入}', scheme_text)

        # 如果有前几轮结果，添加到Prompt中
        if previous_results:
            history = "\n\n前几轮提取结果:\n"
            for idx, prev_result in enumerate(previous_results):
                history += f"第{idx + 1}轮: {prev_result.get('response', '')}\n"
            input_prompt += history

        result = self.mcp_client.call_llm_tool(
            'extract',
            input_prompt,
            provider=self.provider
        )

        response_text = result.get('text', '')

        return {
            'round': round_number,
            'response': response_text,
            'parsed': self._parse_json(response_text),
            'raw_result': result
        }

    def multi_round_extract(
        self,
        scheme_text: str,
        max_rounds: int = 5,
        prompt: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        多轮保险责任推理

        Args:
            scheme_text: 方案文本
            max_rounds: 最大轮次数
            prompt: Prompt模板（可选）

        Returns:
            多轮推理结果列表
        """
        results = []

        for round_num in range(1, max_rounds + 1):
            logger.info(f"执行第{round_num}轮保险责任推理")

            result = self.extract_liability(
                scheme_text,
                round_number=round_num,
                previous_results=results,
                prompt=prompt
            )

            results.append(result)

            # 检查是否需要继续下一轮（可选逻辑）
            # 可以根据结果质量判断是否提前终止

        logger.info(f"多轮推理完成，共{len(results)}轮")
        return results

    def extract_hospital_info(
        self,
        scheme_text: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        医院信息提取

        Args:
            scheme_text: 方案文本
            prompt: Prompt模板（可选）

        Returns:
            医院信息数据
        """
        default_prompt = """从方案文本中提取医院相关信息：

方案文本：
{方案输入}

请提取：
- 指定医院列表
- 医院等级要求
- 就诊限制

以JSON格式输出。"""

        input_prompt = (prompt or default_prompt).replace('{方案输入}', scheme_text)

        result = self.mcp_client.call_llm_tool(
            'extract',
            input_prompt,
            provider=self.provider
        )

        response_text = result.get('text', '')

        return {
            'response': response_text,
            'parsed': self._parse_json(response_text),
            'raw_result': result
        }

    def extract_deductible_info(
        self,
        scheme_text: str,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        免赔限额提取

        Args:
            scheme_text: 方案文本
            prompt: Prompt模板（可选）

        Returns:
            免赔限额数据
        """
        default_prompt = """从方案文本中提取免赔额、赔付限额相关信息：

方案文本：
{方案输入}

请提取：
- 免赔额（次免赔额、年免赔额）
- 赔付限额（次限额、年限额）
- 赔付比例

以JSON格式输出。"""

        input_prompt = (prompt or default_prompt).replace('{方案输入}', scheme_text)

        result = self.mcp_client.call_llm_tool(
            'extract',
            input_prompt,
            provider=self.provider
        )

        response_text = result.get('text', '')

        return {
            'response': response_text,
            'parsed': self._parse_json(response_text),
            'raw_result': result
        }

    def _parse_json(self, text: str) -> Dict[str, Any]:
        """
        从文本中解析JSON

        Args:
            text: 包含JSON的文本

        Returns:
            解析后的字典
        """
        import json
        import re

        # 尝试直接解析
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # 尝试提取JSON部分
        json_pattern = r'\{[\s\S]*\}'
        matches = re.findall(json_pattern, text)

        if matches:
            # 尝试解析最长的JSON
            for match in matches:
                try:
                    return json.loads(match)
                except json.JSONDecodeError:
                    continue

        # 尝试解析Python字典格式
        try:
            # 替换Python格式为JSON格式
            text = text.replace("'", '"')
            return json.loads(text)
        except:
            pass

        logger.warning(f"JSON解析失败，返回空字典")
        return {}