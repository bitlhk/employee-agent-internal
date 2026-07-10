-- Insert default scenarios
INSERT INTO `scenarios` (`id`, `title`, `subtitle`, `description`, `icon`, `displayOrder`, `status`) VALUES
('acquisition', '获客增收', '智能营销获客引擎', '基于AI的精准客户画像与智能推荐系统，帮助金融机构实现高效获客与收入增长。', 'Users', 1, 'active'),
('operations', '运营提效', '智能运营自动化平台', 'AI驱动的流程自动化与智能决策系统，大幅提升金融业务运营效率。', 'Zap', 2, 'active'),
('investment', '投资获利', '智能投研决策系统', '融合大数据分析与AI预测模型，为投资决策提供数据驱动的洞察与建议。', 'TrendingUp', 3, 'active'),
('business-governance', '业务治理', '智能风险识别与预警', '结合规则引擎与大模型能力，覆盖多阶段业务风险识别与处置建议。', 'AlertCircle', 4, 'active');
