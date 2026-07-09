"""
Smart Insurance Skill 0611 - E2E Pipeline完整实现

端到端保险团单解读流程，通过MCP服务间接访问外部网络
"""

import os
import json
import logging
import time
from pathlib import Path
from typing import Dict, Any, Optional, List

from smart_insurance_skill0611.pipeline.base import BasePipeline, PipelineContext, PipelineStep
from smart_insurance_skill0611.core.config import SkillConfig
from smart_insurance_skill0611.core.exceptions import PipelineError, ExtractionError
from smart_insurance_skill0611.core.mcp_client import MCPClient, MCPClientPool
from smart_insurance_skill0611.tools.vision_tool import VisionTool
from smart_insurance_skill0611.tools.llm_tool import LLMTool
from smart_insurance_skill0611.tools.extraction_tool import ExtractionTool
from smart_insurance_skill0611.tools.document_tool import DocumentTool
from smart_insurance_skill0611.templates.template_manager import TemplateManager
from smart_insurance_skill0611.output.html_exporter import HTMLExporter
from smart_insurance_skill0611.output.excel_exporter import ExcelExporter
from smart_insurance_skill0611.output.json_formatter import JSONFormatter
from smart_insurance_skill0611.core.data_processing import DataProcessor

logger = logging.getLogger(__name__)


class E2EPipeline(BasePipeline):
    """
    端到端保险团单解读Pipeline

    完整流程（通过MCP服务间接访问）：
    1. 初始化输出目录
    2. PDF转图片（通过MCP）
    3. 多模态识别（页面分类、文本抽取、表格抽取）- 通过MCP
    4. 文本合并
    5. LLM层级方案推理 + 合同分割 + 报价单提取 - 通过MCP
    6. LLM基础信息提取 - 通过MCP
    7. LLM保险责任多轮推理（5轮）- 通过MCP
    8. 数据处理（合并、排序、字段映射）
    9. JSON输出

    使用示例:
        config = SkillConfig.from_yaml('config.yaml')
        pipeline = E2EPipeline(config)

        result = pipeline.run({
            'task_id': 'T001',
            'pdf_path': './contract.pdf',
            'images': ['./quote1.png', './quote2.png'],
            'mcp_server_url': 'http://mcp-server:8080'
        })
    """

    DEFAULT_STEPS = [
        PipelineStep('init_dirs', '初始化输出目录', timeout=10),
        PipelineStep('pdf_to_image', 'PDF转图片', timeout=60),
        PipelineStep('vision_classify', '页面分类', timeout=180),
        PipelineStep('vision_extract', '文本抽取', timeout=180),
        PipelineStep('text_merge', '文本合并', timeout=30),
        PipelineStep('llm_directory', '层级方案推理', timeout=120),
        PipelineStep('llm_basic', '基础信息提取', timeout=120),
        PipelineStep('llm_liability', '保险责任推理', timeout=300),
        PipelineStep('data_process', '数据处理', timeout=30),
        PipelineStep('output', '结果输出', timeout=30),
    ]

    def __init__(self, config: SkillConfig):
        super().__init__(config.to_dict(), "E2EPipeline")

        self.skill_config = config
        self.steps = self.DEFAULT_STEPS.copy()

        # 初始化子组件
        self.document_tool = DocumentTool()
        self.extraction_tool = ExtractionTool()

        # 延迟初始化（需要MCP连接）
        self._mcp_client: Optional[MCPClient] = None
        self._mcp_pool: Optional[MCPClientPool] = None
        self._vision_tool: Optional[VisionTool] = None
        self._llm_tool: Optional[LLMTool] = None
        self._template_manager: Optional[TemplateManager] = None

        # 数据存储
        self._directory_data: Dict = {}
        self._contract_text: str = ""
        self._quotation_text: str = ""
        self._output_json: Dict = {}
        self._output_dirs: Dict[str, str] = {}

        # 输出格式化器
        self._html_exporter: Optional[HTMLExporter] = None
        self._excel_exporter: Optional[ExcelExporter] = None
        self._json_formatter: Optional[JSONFormatter] = None

        # 数据处理器
        self._data_processor: Optional[DataProcessor] = None

    def _init_mcp_clients(self, mcp_server_url: Optional[str] = None) -> None:
        """初始化MCP客户端"""
        # 如果提供了MCP服务器URL，更新配置
        if mcp_server_url:
            self.skill_config.set('mcp.server_url', mcp_server_url)

        # 创建MCP客户端
        self._mcp_client = MCPClient(self.skill_config)
        self._mcp_pool = MCPClientPool(
            self.skill_config,
            max_concurrency=self.skill_config.get('vision.max_concurrency', 5)
        )

        # 初始化工具
        self._vision_tool = VisionTool(
            self._mcp_client,
            provider=self.skill_config.get('vision.provider', 'maas')
        )

        self._llm_tool = LLMTool(
            self._mcp_client,
            provider=self.skill_config.get('llm.default_provider', 'maas')
        )

        # 初始化模板管理器
        self._template_manager = TemplateManager(
            base_dir=self.skill_config.get('templates.base_dir', './templates')
        )

        # 初始化输出格式化器
        self._html_exporter = HTMLExporter()
        self._excel_exporter = ExcelExporter()
        self._json_formatter = JSONFormatter()

        # 初始化数据处理器
        self._data_processor = DataProcessor()

        logger.info(f"MCP客户端初始化完成: {self.skill_config.get('mcp.server_url')}")

    def run(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行端到端流程"""
        self._init_context(inputs)
        self._init_mcp_clients(inputs.get('mcp_server_url'))

        try:
            task_id = inputs.get('task_id', 'default')

            # 步骤1：初始化目录
            self._output_dirs = self._step_init_dirs(inputs)
            self._update_progress(5, 'init_dirs')

            # 步骤2：PDF转图片（如果提供了PDF）
            contract_images = self._step_pdf_to_image(inputs)
            self._update_progress(10, 'pdf_to_image')

            # 步骤3：多模态页面分类
            form_page_images = self._step_vision_classify(contract_images)
            self._update_progress(20, 'vision_classify')

            # 步骤4：多模态文本抽取
            self._step_vision_extract(form_page_images, inputs.get('images', []))
            self._update_progress(40, 'vision_extract')

            # 步骤5：文本合并
            self._step_text_merge()
            self._update_progress(50, 'text_merge')

            # 步骤6：层级方案推理
            self._step_llm_directory()
            self._update_progress(60, 'llm_directory')

            # 步骤7：基础信息提取
            self._step_llm_basic_info()
            self._update_progress(75, 'llm_basic')

            # 步骤8：保险责任多轮推理
            self._step_llm_liability()
            self._update_progress(90, 'llm_liability')

            # 步骤9：数据处理
            self._step_data_process()
            self._update_progress(95, 'data_process')

            # 步骤10：结果输出
            result = self._step_output(task_id)
            self._update_progress(100, 'output')

            self._finalize_context()

            elapsed_time = self.get_elapsed_time()
            logger.info(f"Pipeline执行完成，耗时: {elapsed_time:.2f}秒")

            return result

        except Exception as e:
            self._context.status = 'failed'
            self._context.errors.append(str(e))
            logger.error(f"Pipeline执行失败: {e}")
            raise PipelineError(f"流程执行失败: {e}")

    def _step_init_dirs(self, inputs: Dict[str, Any]) -> Dict[str, str]:
        """步骤1：初始化输出目录"""
        task_id = inputs.get('task_id', 'default')
        base_dir = self.skill_config.get('pipeline.output.base_dir', './outputs')

        dirs = self.document_tool.create_output_directory(
            base_dir,
            task_id,
            subdirs=['contract', 'ocr', 'quotation', 'data', 'log', 'split', 'images']
        )

        logger.info(f"输出目录初始化完成: {dirs}")
        return dirs

    def _step_pdf_to_image(self, inputs: Dict[str, Any]) -> List[str]:
        """步骤2：PDF转图片"""
        pdf_path = inputs.get('pdf_path')
        if not pdf_path:
            logger.info("未提供PDF文件，跳过PDF转图片步骤")
            return []

        # 通过MCP调用PDF转图片服务
        # 注意：这里需要MCP服务器支持PDF处理
        try:
            result = self._mcp_client.call_tool(
                'pdf_to_images',
                {
                    'pdf_path': pdf_path,
                    'output_dir': self._output_dirs['images'],
                    'dpi': self.skill_config.get('pipeline.pdf.dpi', 200)
                }
            )

            images = result.get('images', [])
            logger.info(f"PDF转图片完成，共{len(images)}页")
            return images

        except Exception as e:
            logger.warning(f"PDF转图片失败（通过MCP）: {e}")
            logger.info("将使用其他方式处理PDF")
            return []

    def _step_vision_classify(self, contract_images: List[str]) -> List[str]:
        """步骤3：多模态页面分类"""
        if not contract_images:
            logger.info("没有合同图片，跳过页面分类")
            return []

        # 设置Few-shot样例
        fewshot_dir = self._template_manager.get_fewshot_dir()
        if os.path.exists(fewshot_dir):
            self._vision_tool.set_fewshot_images(fewshot_dir)

        # 批量分类
        form_pages = self._vision_tool.filter_form_pages(contract_images)

        logger.info(f"筛选出{len(form_pages)}个表单页（共{len(contract_images)}页）")
        return form_pages

    def _step_vision_extract(
        self,
        contract_images: List[str],
        quote_images: List[str]
    ) -> None:
        """步骤4：多模态文本抽取"""
        # 加载Prompt模板
        prompts = self._template_manager.load_prompts('insurance')

        # 抽取合同文本
        contract_results = self._vision_tool.batch_process(
            contract_images,
            tool_type='extract_text',
            prompts=[prompts.get('extract_text')] * len(contract_images)
        )

        # 保存OCR结果
        for idx, result in enumerate(contract_results):
            if 'page_tag' in result:
                output_file = os.path.join(
                    self._output_dirs['ocr'],
                    f'page_{idx + 1:02d}.txt'
                )
                self.document_tool.write_text_file(output_file, result['page_tag'])

        # 抽取报价单文本
        if quote_images:
            quote_results = self._vision_tool.batch_process(
                quote_images,
                tool_type='quotation',
                prompts=[prompts.get('quotation')] * len(quote_images)
            )

            # 保存报价单结果
            for idx, result in enumerate(quote_results):
                if 'scheme_info' in result or 'agreement' in result:
                    output_file = os.path.join(
                        self._output_dirs['quotation'],
                        f'quotation_{idx + 1:02d}.txt'
                    )
                    content = json.dumps(result, ensure_ascii=False)
                    self.document_tool.write_text_file(output_file, content)

        logger.info(f"文本抽取完成，合同{len(contract_results)}页，报价单{len(quote_images)}页")

    def _step_text_merge(self) -> None:
        """步骤5：文本合并"""
        # 合同文本合并
        contract_merged = self.document_tool.merge_texts(
            self._output_dirs['ocr'],
            os.path.join(self._output_dirs['ocr'], 'merged.txt'),
            enable_page_tag=True
        )

        # 报价单文本合并
        quotation_merged = self.document_tool.merge_texts(
            self._output_dirs['quotation'],
            os.path.join(self._output_dirs['quotation'], 'merged.txt'),
            enable_page_tag=False
        )

        # 读取合并后的文本
        if contract_merged:
            self._contract_text = self.document_tool.read_text_file(contract_merged)

        if quotation_merged:
            self._quotation_text = self.document_tool.read_text_file(quotation_merged)

        logger.info("文本合并完成")

    def _step_llm_directory(self) -> None:
        """步骤6：层级方案关系推理"""
        # 加载层级关系Prompt模板
        prompt = self._template_manager.get_prompt('directory_relation')

        # LLM推理层级和方案关系
        directory_result = self._llm_tool.infer_directory(
            self._contract_text,
            prompt=prompt
        )

        contract_directory = directory_result.get('parsed', {})

        # 报价单方案内容推理
        quotation_prompt = self._template_manager.get_prompt('quotation_relation')
        quotation_result = self._llm_tool.call_llm_tool(
            'extract',
            quotation_prompt.replace('{报价单输入}', self._quotation_text)
        )

        quotation_scheme_content = quotation_result.get('text', '')

        # 合同分割
        contract_merged_path = os.path.join(self._output_dirs['ocr'], 'merged.txt')
        quotation_merged_path = os.path.join(self._output_dirs['quotation'], 'merged.txt')

        contract_extracted = self.extraction_tool.extract_contract_content(
            contract_directory.get('方案名称', []),
            contract_merged_path
        )

        quotation_extracted = self.extraction_tool.extract_quotation_content(
            quotation_merged_path
        )

        # 数据合并
        self._directory_data = self.extraction_tool.merge_contract_quotation(
            contract_extracted,
            quotation_extracted
        )

        # 添加原始推理结果
        self._directory_data['directory_json'] = contract_directory
        self._directory_data['quotation_json'] = quotation_scheme_content

        logger.info(f"层级方案推理完成: {len(contract_directory.get('方案名称', []))}个方案")

    def _step_llm_basic_info(self) -> None:
        """步骤7：基础信息提取"""
        # 加载基础信息Prompt模板
        prompt = self._template_manager.get_prompt('basic_info')

        # LLM提取基础信息
        basic_result = self._llm_tool.extract_basic_info(
            self._contract_text,
            self._quotation_text,
            prompt=prompt
        )

        basic_info = basic_result.get('parsed', {})

        # 初始化输出JSON
        self._output_json = {
            '保单基本信息': basic_info.get('保单基本信息', {}),
            '团单特约': basic_info.get('团单特约', {}),
            '个人特约': basic_info.get('个人特约', []),
            '其他特约': basic_info.get('其他特约', []),
            '方案信息': {}
        }

        # 为每个方案提取方案特约
        schemes = self._directory_data.get('directory_json', {}).get('方案名称', [])
        scheme_special_prompt = self._template_manager.get_prompt('scheme_special')

        for scheme_name in schemes:
            scheme_text = self._directory_data.get(scheme_name, '')
            if scheme_text:
                scheme_result = self._llm_tool.extract_scheme_special(
                    scheme_text,
                    prompt=scheme_special_prompt
                )

                self._output_json['方案信息'][scheme_name] = {
                    '方案特约': scheme_result.get('parsed', {}).get('方案特约', '')
                }

        logger.info("基础信息提取完成")

    def _step_llm_liability(self) -> None:
        """步骤8：保险责任多轮推理 + 二次推理"""
        schemes = self._directory_data.get('directory_json', {}).get('方案名称', [])

        # 加载保险责任Prompt模板
        liability_prompt = self._template_manager.get_prompt('liability')

        all_liability_data = []

        for scheme_name in schemes:
            scheme_text = self._directory_data.get(scheme_name, '')
            if scheme_text:
                # 主推理：多轮推理（最多5轮）
                liability_results = self._llm_tool.multi_round_extract(
                    scheme_text,
                    max_rounds=5,
                    prompt=liability_prompt
                )

                # 合并多轮结果
                merged_liability = []
                for result in liability_results:
                    parsed = result.get('parsed', {})
                    if parsed:
                        merged_liability.extend(parsed.get('保险责任列表', []))

                # 二次推理1：赔付信息提取
                payment_prompt = self._template_manager.get_prompt('payment_info')
                if payment_prompt:
                    payment_data = self._extract_secondary_info(
                        scheme_text,
                        merged_liability,
                        payment_prompt,
                        'payment'
                    )

                    # 合并赔付信息
                    if payment_data:
                        merged_liability = self._data_processor.merge_secondary_results(
                            merged_liability,
                            payment_data
                        )

                # 二次推理2：免赔限额提取(已有)
                deductible_prompt = self._template_manager.get_prompt('deductible_limit')
                if deductible_prompt:
                    deductible_data = self._extract_secondary_info(
                        scheme_text,
                        merged_liability,
                        deductible_prompt,
                        'deductible'
                    )

                    # 合并免赔限额信息
                    if deductible_data:
                        merged_liability = self._data_processor.merge_secondary_results(
                            merged_liability,
                            deductible_data
                        )

                # 二次推理3：指定医院提取
                hospital_prompt = self._template_manager.get_prompt('hospital_designated')
                if hospital_prompt:
                    hospital_data = self._extract_secondary_info(
                        scheme_text,
                        merged_liability,
                        hospital_prompt,
                        'hospital'
                    )

                    # 合并医院信息
                    if hospital_data:
                        merged_liability = self._data_processor.merge_secondary_results(
                            merged_liability,
                            hospital_data
                        )

                # 二次推理4：方案特约提取
                scheme_special_prompt = self._template_manager.get_prompt('scheme_special')
                if scheme_special_prompt:
                    scheme_special_data = self._extract_scheme_special(
                        scheme_text,
                        scheme_special_prompt
                    )

                    # 合并方案特约
                    if scheme_special_data:
                        merged_liability = self._merge_scheme_special(
                            merged_liability,
                            scheme_special_data
                        )

                # 验证字段完整性
                merged_liability = self._data_processor.validate_liability_fields(merged_liability)

                # 添加方案名称字段
                for item in merged_liability:
                    item['方案名称'] = scheme_name

                all_liability_data.extend(merged_liability)

                self._output_json['方案信息'][scheme_name]['保险责任'] = merged_liability

        # 按层级关系排序
        if self._directory_data:
            all_liability_data = self._data_processor.order_by_hierarchy(
                all_liability_data,
                self._directory_data
            )

        # 更新全局保险责任数据
        self._output_json['insurance_liability'] = all_liability_data

        logger.info(f"保险责任推理完成（含二次推理），共{len(schemes)}个方案，{len(all_liability_data)}条记录")

    def _extract_secondary_info(
        self,
        scheme_text: str,
        liability_data: List[Dict],
        prompt: str,
        extract_type: str
    ) -> Optional[List[Dict]]:
        """
        执行二次推理提取特定信息

        Args:
            scheme_text: 方案文本
            liability_data: 主推理的保险责任数据
            prompt: 二次推理Prompt
            extract_type: 提取类型(payment/deductible/hospital)

        Returns:
            二次推理结果列表
        """
        try:
            # 构造输入数据
            liability_list_str = json.dumps(liability_data, ensure_ascii=False)

            # 替换Prompt中的占位符
            input_prompt = prompt.replace('{合同层级部分输入}', scheme_text)
            input_prompt = input_prompt.replace('{列表数据}', liability_list_str)

            # 调用LLM进行二次推理
            result = self._llm_tool.call_llm_tool('extract', input_prompt)

            # 解析结果
            parsed_result = self._data_processor.extract_json_structure(result.get('text', ''))

            if parsed_result and isinstance(parsed_result, list):
                return parsed_result

            logger.warning(f"二次推理{extract_type}提取失败，未得到有效JSON结构")
            return None

        except Exception as e:
            logger.error(f"二次推理{extract_type}提取出错: {str(e)}")
            return None

    def _extract_scheme_special(
        self,
        scheme_text: str,
        prompt: str
    ) -> Optional[Dict[str, str]]:
        """
        提取方案特约信息

        Args:
            scheme_text: 方案文本
            prompt: 方案特约提取Prompt

        Returns:
            方案特约数据字典
        """
        try:
            # 替换Prompt中的占位符
            input_prompt = prompt.replace('{合同层级部分输入}', scheme_text)

            # 调用LLM提取方案特约
            result = self._llm_tool.call_llm_tool('extract', input_prompt)

            # 解析结果
            parsed_result = self._data_processor.extract_json_structure(result.get('text', ''))

            if parsed_result:
                return parsed_result

            logger.warning("方案特约提取失败，未得到有效JSON结构")
            return None

        except Exception as e:
            logger.error(f"方案特约提取出错: {str(e)}")
            return None

    def _merge_scheme_special(
        self,
        liability_data: List[Dict],
        scheme_special_data: Dict[str, str]
    ) -> List[Dict]:
        """
        合并方案特约到保险责任数据

        Args:
            liability_data: 保险责任数据列表
            scheme_special_data: 方案特约数据

        Returns:
            合并后的保险责任数据列表
        """
        if not scheme_special_data:
            return liability_data

        # 为每条保险责任添加方案特约字段
        for item in liability_data:
            item['方案特约'] = scheme_special_data.get('方案特约', '')

        return liability_data

    def _step_data_process(self) -> None:
        """步骤9：数据处理"""
        # 字段映射（中文转英文）
        from smart_insurance_skill0611.core.constants import FIELD_MAPPINGS

        cn_to_en = FIELD_MAPPINGS['cn_to_en']

        # 转换保单基本信息
        basic_info = self._output_json.get('保单基本信息', {})
        basic_info_en = {}
        for cn_key, value in basic_info.items():
            en_key = cn_to_en.get(cn_key, cn_key)
            basic_info_en[en_key] = value

        self._output_json['policy_basic_info'] = basic_info_en

        # 转换团单特约
        group_agreement = self._output_json.get('团单特约', {})
        group_agreement_en = {}
        for cn_key, value in group_agreement.items():
            en_key = cn_to_en.get(cn_key, cn_key)
            group_agreement_en[en_key] = value

        self._output_json['group_agreement'] = group_agreement_en

        # 添加元数据
        self._output_json['metadata'] = {
            'task_id': self._context.task_id,
            'elapsed_time': self.get_elapsed_time(),
            'status': 'completed',
            'timestamp': time.time()
        }

        logger.info("数据处理完成")

    def _step_output(self, task_id: str) -> Dict[str, Any]:
        """步骤10：结果输出（支持JSON、HTML、Excel多种格式）"""
        # 1. 格式化JSON数据
        formatted_json = self._json_formatter.format(self._output_json, task_id=task_id)

        # 2. 输出JSON文件
        json_file = os.path.join(
            self._output_dirs['data'],
            f'{task_id}_result.json'
        )
        self.document_tool.write_json_file(json_file, formatted_json)
        logger.info(f"JSON结果保存到: {json_file}")

        # 3. 输出HTML报告
        html_content = self._html_exporter.generate(formatted_json, task_id=task_id)
        html_file = os.path.join(
            self._output_dirs['data'],
            f'{task_id}_保单解读详情.html'
        )
        self._html_exporter.save(html_content, html_file)
        logger.info(f"HTML报告保存到: {html_file}")

        # 4. 输出Excel报告（如果openpyxl可用）
        try:
            excel_file = os.path.join(
                self._output_dirs['data'],
                f'{task_id}_保单解读详情.xlsx'
            )
            self._excel_exporter.generate(formatted_json, excel_file)
            logger.info(f"Excel报告保存到: {excel_file}")
        except ImportError:
            logger.warning("openpyxl未安装，跳过Excel报告生成")

        # 返回完整结果
        return {
            'json_file': json_file,
            'html_file': html_file,
            'excel_file': excel_file if 'excel_file' in locals() else None,
            'data': formatted_json
        }


def run_insurance_reading(
    pdf_path: str,
    images: list,
    task_id: str,
    config_path: str = None,
    mcp_server_url: str = None,
    output_formats: list = ['json', 'html', 'excel']
) -> Dict[str, Any]:
    """
    快捷函数：执行保险团单解读

    Args:
        pdf_path: PDF文件路径
        images: 报价单图片路径列表
        task_id: 任务ID
        config_path: 配置文件路径
        mcp_server_url: MCP服务器地址
        output_formats: 输出格式列表（json、html、excel）

    Returns:
        解读结果（包含所有输出文件路径）
    """
    config = SkillConfig.from_yaml(config_path or 'config.yaml')
    pipeline = E2EPipeline(config)
    return pipeline.run({
        'pdf_path': pdf_path,
        'images': images,
        'task_id': task_id,
        'mcp_server_url': mcp_server_url
    })
