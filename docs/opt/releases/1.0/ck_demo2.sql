CREATE OR REPLACE TABLE syncdb.dwd_presale_vehicle_inventory_di
	(
	    vin                     String          COMMENT '车架号(库存主键)',
	    vehicle_id              Int64          COMMENT '车辆ID',
	    brand_code              String          COMMENT '品牌编码',
	    brand_name              String          COMMENT '品牌名称',
	    car_series_code         String          COMMENT '车系编码',
	    car_series              String          COMMENT '车系名称',
	
	    -- 收购信息
	    purchase_time           Nullable(DateTime) COMMENT '收购时间(入库)',
	    purchase_order_code     String          COMMENT '采购订单号',
	    purchase_order_status   String          COMMENT '采购订单状态',
	    acquisition_price       Decimal(18,2)   COMMENT '收购价',
	    first_payment_time      Nullable(DateTime) COMMENT '定金支付时间',
	    final_payment_time      Nullable(DateTime) COMMENT '尾款支付时间',
	
	    -- 销售信息
	    sale_time               Nullable(DateTime) COMMENT '销售时间(出库)',
	    sale_order_code         String          COMMENT '销售订单号',
	    trade_price             Decimal(18,2)   COMMENT '成交价',
	    commission              Decimal(18,2)   COMMENT '佣金',
	    diff_price              Decimal(18,2)   COMMENT '进销差价',
	    sale_channels           String          COMMENT '销售渠道',
	
	    -- 库存维度
	    distributor_id          Int64          COMMENT '经销商ID',
	    distributor_shop        String          COMMENT '经销商门店',
	    distributor_city        String          COMMENT '经销商城市',
	    group_id                Int64          COMMENT '集团ID',
	    service_centre_name     String          COMMENT '服务中心名称',
	    assessor_id             Int64          COMMENT '评估师ID',
	    assessor_name           String          COMMENT '评估师名称',
	
	    -- 库存状态标记
	    inventory_status        String          COMMENT '库存状态:在库/已出库',
	    is_scrap                String          COMMENT '报废状态',
	    storage_days            Int32           COMMENT '库龄(天)',
	    is_long_storage         String          COMMENT '是否长库龄(>=7天未售)',
	
	    pt_day                  String          COMMENT '分区(收购日)',
	    update_time             DateTime        COMMENT '更新时间'
	)
ENGINE = ReplacingMergeTree(update_time)
PARTITION BY pt_day
ORDER BY vin;



INSERT INTO syncdb.dwd_presale_vehicle_inventory_di
WITH
purchase AS (
    SELECT
        JSONExtract(property_cols,'vin','String')                    AS vin,
        JSONExtract(property_cols,'vehicle_id','Int64')             AS vehicle_id,
        JSONExtract(property_cols,'brand_code','String')            AS brand_code,
        JSONExtract(property_cols,'brand_name','String')            AS brand_name,
        JSONExtract(property_cols,'car_series_code','String')       AS car_series_code,
        JSONExtract(property_cols,'car_series','String')            AS car_series,
        event_occur_time                                            AS purchase_time,
        JSONExtract(property_cols,'purchase_order_code','String')   AS purchase_order_code,
        JSONExtract(property_cols,'purchase_order_status','String') AS purchase_order_status,
        toDecimal64(JSONExtract(property_cols,'acquisition_price','Float64'),2) AS acquisition_price,
        parseDateTimeBestEffortOrNull(JSONExtract(property_cols,'first_payment_time','String')) AS first_payment_time,
        parseDateTimeBestEffortOrNull(JSONExtract(property_cols,'final_payment_time','String')) AS final_payment_time,
        JSONExtract(property_cols,'distributor_id','Int64')        AS distributor_id,
        JSONExtract(property_cols,'distributor_shop','String')      AS distributor_shop,
        JSONExtract(property_cols,'distributor_city','String')      AS distributor_city,
        JSONExtract(property_cols,'group_id','Int64')              AS group_id,
        JSONExtract(property_cols,'service_centre_name','String')   AS service_centre_name,
        JSONExtract(property_cols,'assessor_id','Int64')           AS assessor_id,
        JSONExtract(property_cols,'assessor_name','String')         AS assessor_name,
        JSONExtract(property_cols,'is_scrap','String')              AS is_scrap
    FROM syncdb.dwd_event_detail_di
    WHERE event_name = 'PURCHASE'
    and purchase_order_status = '交易完成'
),
sale AS (
    SELECT
        JSONExtract(property_cols,'vin','String')                   AS vin,
        event_occur_time                                           AS sale_time,
        JSONExtract(property_cols,'order_code','String')           AS sale_order_code,
        toDecimal64(JSONExtract(property_cols,'trade_price','Float64'),2)  AS trade_price,
        toDecimal64(JSONExtract(property_cols,'commission','Float64'),2)   AS commission,
        toDecimal64(JSONExtract(property_cols,'diff_price','Float64'),2)   AS diff_price,
        JSONExtract(property_cols,'sale_channels','String')        AS sale_channels
    FROM syncdb.dwd_event_detail_di
    WHERE event_name = 'SALE'
)
SELECT
    p.vin,
    p.vehicle_id, p.brand_code, p.brand_name, p.car_series_code, p.car_series,
    p.purchase_time, p.purchase_order_code, p.purchase_order_status,
    p.acquisition_price, p.first_payment_time, p.final_payment_time,
    if(s.vin is null,null,s.sale_time) sale_times, s.sale_order_code, s.trade_price, s.commission, s.diff_price, s.sale_channels,
    p.distributor_id, p.distributor_shop, p.distributor_city, p.group_id,
    p.service_centre_name, p.assessor_id, p.assessor_name,
    if(sale_times is not null, '已出库','在库')                       AS inventory_status,
    p.is_scrap,
    dateDiff('day', p.purchase_time,
             if(sale_times is not null, s.sale_time, now())) AS storage_days,
    if(sale_times is null
       AND dateDiff('day', p.purchase_time, now()) >= 7, '是', '否') AS is_long_storage,
    formatDateTime(p.purchase_time, '%Y%m%d')                       AS pt_day,
    now()                                                           AS update_time
FROM purchase p
LEFT JOIN sale s ON p.vin = s.vin;