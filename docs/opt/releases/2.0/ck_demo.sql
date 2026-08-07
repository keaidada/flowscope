CREATE OR REPLACE TABLE syncdb.dwd_yl_auction_deal_return_tmp
(
	vehicle_auction_id	 Int32 COMMENT '竞拍ID',
	session_id Nullable(Int32) COMMENT '场次ID',
	session_name Nullable(String) COMMENT '场次名称',
	session_auction_type_value Nullable(String) COMMENT '竞拍规则',
	session_code Nullable(String) COMMENT '场次编码',
	auction_duration Nullable(Int32) COMMENT '竞拍时长(秒)',
    auction_interval Nullable(Int32) COMMENT '竞拍间隔',
	auction_session_begin_time Nullable(DateTime64(3)) COMMENT '场次开拍时间',
	session_final_number Nullable(Int32) COMMENT '场次最终接收数量',
	session_bid_security Nullable(Decimal(10,2)) COMMENT '出价保证金',
    session_transfer_deposit Nullable(Decimal(10,2)) COMMENT '过户押金',
	nonmember_visible Nullable(Int8) COMMENT '无权限会员是否可见0否|1是',
	online_auction_type Nullable(String) COMMENT '场次类型',
	vehicle_id Nullable(Int32) COMMENT '车辆ID',
	vehicle_code Nullable(String) COMMENT '车辆编码',
	vehicle_created_time Nullable(DateTime) COMMENT '车辆创建时间',
	vehicle_create_id Nullable(Int32) COMMENT '车辆创建者id',
	vin_code Nullable(String) COMMENT '车架号',
	vehicle_plate_number Nullable(String) COMMENT '车牌号',
	vehicle_brand Nullable(String) COMMENT '车辆品牌',
	vehicle_series Nullable(String) COMMENT '车系',
	vehicle_series_code Nullable(String) COMMENT '车系code',
	vehicle_name Nullable(String) COMMENT '车型',
	vehicle_kilometers Nullable(Float64) COMMENT '表显里程数(万)',
	transfer_count Nullable(Int32) COMMENT '过户次数',
	vehicle_age Nullable(Float64) COMMENT '车龄',
	vehicle_energy_type Nullable(String) COMMENT '能源类型',
	vehicle_displacement Nullable(String) COMMENT '排量',
	vehicle_source Nullable(String) COMMENT '车辆来源',
	vehicle_nature Nullable(String) COMMENT '车辆性质',
	vehicle_used_type Nullable(String) COMMENT '使用性质',
	estimated_price Nullable(decimal(10,2)) COMMENT '预估价(万)',
	vehicle_registration_date Nullable(DateTime64(3)) COMMENT '登记日期',
	vehicle_manufacturing_date Nullable(DateTime64(3)) COMMENT '出厂日期',
	vehicle_trafficinsurance_date Nullable(DateTime64(3)) COMMENT '交强险到期时间',
	vehicle_commercial_insurance_date Nullable(DateTime64(3)) COMMENT '商业险到期时间',
	vehicle_annual_inspection_date Nullable(DateTime64(3)) COMMENT '年检到期日',
	vehicle_belong_city Nullable(String) COMMENT '车辆归属地城市 ',
	vehicle_belong_province Nullable(String) COMMENT '车辆归属地省份',
	vehicle_location_city Nullable(String) COMMENT '车辆所在地城市',
	vehicle_location_province Nullable(String) COMMENT '车辆所在地省份',
	three_way_catalyst_value Nullable(String) COMMENT '三元催化(有无)',
	report_rating Nullable(String) COMMENT '报告等级',
	report_url Nullable(String) DEFAULT NULL COMMENT '报告地址',
	appraiser Nullable(String) DEFAULT NULL COMMENT '评估师',
	free_worry_detection Nullable(String) COMMENT '是否有辆检',
	vehicle_detection_method Nullable(String) COMMENT '检测方式',
	is_major_accident_value Nullable(String) COMMENT '是否重大事故',
	distributor_id Nullable(Int32) COMMENT '委托方ID',
	distributor Nullable(String) COMMENT '委托方名称',
	distributor_code Nullable(String) COMMENT '委托方编码',
	distributor_province_name Nullable(String) COMMENT '委托方所在省份',
	distributor_city_name Nullable(String) COMMENT '委托方所在市',
	distributor_brand Nullable(String) COMMENT '委托方品牌',
	distributor_created_time Nullable(DateTime64(3)) COMMENT '委托方创建时间',
	distributor_first_valid_auction_time Nullable(DateTime) COMMENT '委托方首次参拍时间',
	distributor_full_name Nullable(String) COMMENT '委托方全称',
	is_delivery_money_value Nullable(String) COMMENT '享辆拍是否代收车款',
	distributor_center_name Nullable(String) COMMENT '委托方归属中心',
	third_distributor_code Nullable(String) COMMENT '第三方店铺编码',
	group_id Nullable(Int32) COMMENT '集团ID',
	group_name Nullable(String) COMMENT '集团名称',
	centre_id Nullable(Int32) COMMENT '中心ID',
	centre_name Nullable(String) COMMENT '中心名称',
	centre_type Nullable(String) COMMENT '中心类型',
	centre_contact_name Nullable(String) COMMENT '中心联系人',
	member_id Nullable(Int32) COMMENT '会员ID',
	member_name Nullable(String) COMMENT '会员姓名',
	membership Nullable(String) COMMENT '入会状态',
	member_director Nullable(String) COMMENT '维护顾问',
	service_centre_name Nullable(String) COMMENT '会员归属中心',
	member_mobile_phone Nullable(String) COMMENT '会员手机号',
	id_number  Nullable(String) COMMENT '身份证号',
	vehicle_migrate_city Nullable(String) COMMENT '车辆迁往城市',
	vehicle_migrate_province Nullable(String) COMMENT '车辆迁往地省份',
	agency_name Nullable(String) COMMENT '代办公司名称',
	procedure_return_time Nullable(DateTime64(3)) COMMENT '过户手续上传时间',
	transfer_completion_time Nullable(DateTime64(3)) COMMENT '过户手续完成时间',
	is_authenticated Nullable(String) COMMENT '过户手续是否保真',
	auction_time Nullable(DateTime64(3)) COMMENT '参拍时间',
	goods_status Nullable(String) COMMENT '参拍状态',
	starting_auction_price Nullable(decimal(10,2)) COMMENT '起拍价',
	retention_price Nullable(decimal(10,2)) COMMENT '保留价',
	deal_price Nullable(decimal(10,2)) COMMENT '成交价',
	aborted_fee Nullable(decimal(10,2)) COMMENT '流拍价',
	deal_amount Nullable(decimal(10,2)) COMMENT '成交额',
	discount_type Nullable(String) COMMENT '补贴促销类型：自动补贴，出价补贴',
	set_discount_type Nullable(String) COMMENT '设置补贴类型：自动补贴，出价补贴',
	discount_amount Nullable(decimal(10,2)) COMMENT '补贴金额',
--	coupon_name Nullable(decimal(10,2)) COMMENT '优惠券名字(促销券,抽奖券...)',
	coupon_distribution_id Nullable(Int64) COMMENT '优惠卷发放记录id',
	coupon_price Nullable(decimal(10,2)) COMMENT '优惠券金额',
	goods_type Nullable(String) COMMENT '车辆类型',
	vehicle_data_sources Nullable(String) COMMENT '车辆上拍来源',
	deal_type Nullable(String) COMMENT '成交方式',
	auction_created_time Nullable(DateTime64(3)) COMMENT '参拍创建时间',
	vehicle_order_status Nullable(String) COMMENT '订单状态',
	vehicle_order_code Nullable(String) COMMENT '订单编号',
	transfer_method Nullable(String) COMMENT '代办方式',
	transfer_status Nullable(String) COMMENT '过户状态',
	is_dispute Nullable(String) COMMENT '是否争议',
	transfer_status_modified_time Nullable(DateTime64(3)) COMMENT '过户状态创建时间',
	agent_modified_time Nullable(DateTime64(3)) COMMENT '过户状态变更时间',
	transfer_requirements Nullable(Int8) COMMENT '过户条件',
	commission Nullable(decimal(10,2)) COMMENT '佣金',
	delivery_fee Nullable(decimal(10,2)) COMMENT '交付费',
	delivery_fee_set Nullable(decimal(10,2)) COMMENT '交付费设置金额',
	check_fee Nullable(decimal(10,2)) COMMENT '检测费',
	storage_fee Nullable(decimal(10,2)) COMMENT '仓储费',
	group_mgt_fee Nullable(decimal(10,2)) COMMENT '集团管理费',
	vehicle_source_service_fee Nullable(decimal(10,2)) COMMENT '车源服务费',
	other_fee Nullable(decimal(10,2)) COMMENT '其他费用',
	agency_fee Nullable(Decimal(18, 2)) COMMENT '代理费',
	sys_use_fee Nullable(decimal(10,2)) COMMENT '系统使用费',
	total_order_amount Nullable(decimal(10,2)) COMMENT '成交总价',
	collection_number Nullable(String) COMMENT '收款单号',
	collection_code Nullable(String) COMMENT '收款单据号',
	order_created_time Nullable(DateTime64(3)) COMMENT '订单时间',
	income Nullable(decimal(10,2)) COMMENT '收入',
	return_vehicle_time Nullable(DateTime64(3)) COMMENT '退车时间',
	order_modified_time Nullable(DateTime64(3)) COMMENT '订单更新时间',
	order_return_time Nullable(DateTime64(3)) COMMENT '退车时间(订单显示)',
	invoicing_time Nullable(DateTime64(3)) COMMENT '进销存时间',
	order_service_centre_id Nullable(Int32) COMMENT '中心ID(订单)',
	pay_user_name Nullable(String) COMMENT '付款人',
	collection_time Nullable(DateTime64(3)) COMMENT '收款日期',
	payment_time Nullable(DateTime64(3)) COMMENT '完成收款时间',
	transfer_date Nullable(DateTime64(3)) COMMENT '运营点实际收款时间',
	remittance Nullable(decimal(10,2)) COMMENT '汇款',
	ping_amt Nullable(decimal(10,2)) COMMENT 'PING++支付金额',
	collection_amt_total Nullable(decimal(10,2)) COMMENT '收款合计',
	wechat_pay_amt Nullable(decimal(10,2)) COMMENT '微信支付金额',
	alipay_amt Nullable(decimal(10,2)) COMMENT '支付宝支付金额',
--	is_xktb Nullable(String) COMMENT '是否星空提报',
	dispute_time Nullable(DateTime64(3)) COMMENT '争议时间',
	dispute_type Nullable(String) COMMENT '争议类别',
	responsible_party Nullable(String) COMMENT '责任方',
	continue_trading Nullable(String) COMMENT '是否继续交易(退车)',
	is_brush_num Nullable(String) COMMENT '是否刷数',
	is_brush_num_deal Nullable(String) COMMENT '是否刷数(成交)',
	auction_cnt Nullable(Int32) COMMENT '参拍量',
	bid_cnt Nullable(Int32) COMMENT '出价次数',
	bid_user_cnt Nullable(Int32) COMMENT '出价人数',
	deal_cnt Nullable(Int32) COMMENT '成交量',
	auctioin_order_curday Nullable(Int32) COMMENT '当日参拍顺序',
	auction_order_acc Nullable(Int32) COMMENT '累计参拍顺序',
	auction_order_his Nullable(Int32) COMMENT '历史参拍顺序',
	forecast_delivery_profit Nullable(decimal(10,2)) COMMENT '预估交付费利润',
	forecast_vehicle_source_fee Nullable(decimal(10,2)) COMMENT '预估车源费',
	fav_cnt Nullable(Int32) COMMENT '关注人数',
	vehicle_tag Nullable(String) COMMENT '辆典车',
	auction_user_cnt Nullable(Int32) COMMENT '参拍人数(人车比)',
	host_manufacturer_name Nullable(String) comment '主机厂',
	manufacturers Nullable(String) comment '厂家',
	settle_accounts_fee Nullable(decimal(30,2)) COMMENT '交付费结算金额',
	starting_price Nullable(Decimal(10,2)) DEFAULT NULL COMMENT '预估价范围(最低)',
	end_price Nullable(Decimal(10,2)) DEFAULT NULL COMMENT '预估价范围(最高)',
	goods_begin_time Nullable(Datetime) COMMENT '商品开拍时间',
	goods_end_time Nullable(Datetime) COMMENT '商品拍卖结束时间',
	`free_margin` Nullable(Decimal(10,2)) COMMENT '会员当前可用保证金',
    `freeze_margin` Nullable(Decimal(10,2)) COMMENT '冻结保证金',
    `total_margin_amount` Nullable(Decimal(10,2)) COMMENT '保证金总额',
    `pay_type` Nullable(Int8) COMMENT '支付方式:1-微信、2-支付宝、3-转账、4-ping++  5-中信',
    vehicle_package_count Nullable(Int64) COMMENT '车辆包数量',
    `etl_time` Nullable(DateTime64(3)) COMMENT '数据更新时间',
    `_sign` Int8 DEFAULT 1,
    `_version` UInt64 DEFAULT 1
)
ENGINE = MergeTree
PRIMARY KEY vehicle_auction_id
;


insert into syncdb.dwd_yl_auction_deal_return_tmp
(
	vehicle_auction_id,
	session_id,
	session_name,
	session_auction_type_value,
	session_code,
	auction_duration,
	auction_interval,
	auction_session_begin_time,
	session_final_number,
	session_bid_security,
	session_transfer_deposit,
	nonmember_visible,
	online_auction_type,
	vehicle_id,
	vehicle_code,
	vehicle_created_time,
	vehicle_create_id,
	vin_code,
	vehicle_plate_number,
	vehicle_brand,
	vehicle_series,
	vehicle_series_code,
	vehicle_name,
	vehicle_kilometers,
	transfer_count,
	vehicle_age,
	vehicle_energy_type,
	vehicle_displacement,
	vehicle_source,
	vehicle_nature,
	vehicle_used_type,
	estimated_price,
	vehicle_registration_date,
	vehicle_manufacturing_date,
	vehicle_trafficinsurance_date,
	vehicle_commercial_insurance_date,
	vehicle_annual_inspection_date,
	vehicle_belong_city,
	vehicle_belong_province,
	vehicle_location_city,
	vehicle_location_province,
	three_way_catalyst_value,
	report_rating,
	report_url,
	appraiser,
	free_worry_detection,
	vehicle_detection_method,
	is_major_accident_value,
	distributor_id,
	distributor,
	distributor_code,
	distributor_province_name,
	distributor_city_name,
	distributor_brand,
	distributor_created_time,
	distributor_first_valid_auction_time,
	distributor_full_name,
	is_delivery_money_value,
	distributor_center_name,
	third_distributor_code,
	group_id,
	group_name,
	centre_id,
	centre_name,
	centre_type,
	centre_contact_name,
	member_id,
	member_name,
	membership,
	member_director,
	service_centre_name,
	member_mobile_phone,--会员手机号
	id_number,--身份证号
	vehicle_migrate_city,
	vehicle_migrate_province,
	agency_name,
	procedure_return_time,
	transfer_completion_time,
	is_authenticated,
	auction_time,
	goods_status,
	starting_auction_price,
	retention_price,
	deal_price,
	aborted_fee,
	deal_amount,
	discount_type,
	set_discount_type,
	discount_amount,
--	coupon_name,
	coupon_distribution_id,
	coupon_price,
	goods_type,
	vehicle_data_sources,
	deal_type,
	auction_created_time,
	vehicle_order_status,
	vehicle_order_code,
	transfer_method,
	transfer_status,
	is_dispute,
	transfer_status_modified_time,
	agent_modified_time,
	transfer_requirements,
	commission,
	delivery_fee,
	delivery_fee_set,
	check_fee,
	storage_fee,
	group_mgt_fee,
	vehicle_source_service_fee,
	other_fee,
	agency_fee,
	sys_use_fee,
	total_order_amount,
	collection_number,
	collection_code,
	order_created_time,
	income,
	return_vehicle_time,
	order_modified_time,
	order_return_time,
	invoicing_time,
	order_service_centre_id,
	pay_user_name,
	collection_time,
	payment_time,
	transfer_date,
	remittance,
	ping_amt,
	collection_amt_total,
	wechat_pay_amt,
	alipay_amt,
--	is_xktb,
	dispute_time,
	dispute_type,
	responsible_party,
	continue_trading,
	is_brush_num,
	is_brush_num_deal,
	auction_cnt,
	bid_cnt,
	bid_user_cnt,
	deal_cnt,
	auctioin_order_curday,
	auction_order_acc,
	auction_order_his,
	forecast_delivery_profit,
	forecast_vehicle_source_fee,
	fav_cnt,
	vehicle_tag,
	auction_user_cnt,
	host_manufacturer_name,
	manufacturers,
	settle_accounts_fee,
	starting_price,
	end_price,
	goods_begin_time,
	goods_end_time,
	free_margin,
	freeze_margin,
	total_margin_amount,
	pay_type,
	vehicle_package_count,
	etl_time
)
with 
auction_cnt as--参拍量
(
	select
	  undeal_auction.id -- 当天没有过成交的车辆按车辆ID取第一次参拍
	from
		(
		    select
		      all_vehicle.id,
		      ROW_NUMBER() over(PARTITION by toDate(all_vehicle.auction_time),all_vehicle.vehicle_id order by all_vehicle.auction_time asc) as row_rank -- 升序
		    from
		    	(
			        select
			          case
			            when goods1.goods_begin_time is null then session1.auction_session_begin_time
			            else goods1.goods_begin_time
			          end as auction_time, -- 参拍时间
			          goods1.vehicle_id,
			          goods1.id,
			          goods1.goods_status
			        from db_youliangpai.yl_auction_goods_info goods1
			        final
			        left join 
			        	(
			        		select
								session_id,
								auction_session_begin_time
							from syncdb.dim_yl_auction_session_tmp
							where is_deleted = 0
			          	) session1
		          	on session1.session_id = goods1.auction_session_id -- 场次表
		        	where goods1._sign = 1
		            and goods1.is_deleted = 0
		      	) all_vehicle
		  	left join 
		  		(
			        -- 排除当日有成交的车辆
			        select
			          toDate(case when goods2.goods_begin_time is null then session2.auction_session_begin_time else goods2.goods_begin_time end) as auction_time, -- 参拍时间
			          goods2.vehicle_id
			       	from db_youliangpai.yl_auction_goods_info goods2
			       	final
			        left join 
			        	(
			                select
								session_id,
								auction_session_begin_time
							from syncdb.dim_yl_auction_session_tmp
							where is_deleted = 0
			          	) session2
			        on session2.session_id = goods2.auction_session_id -- 场次表
			        where goods2.goods_status = 2
				    and goods2._sign = 1
				    and goods2.is_deleted = 0
			        group by 
			        	toDate(case when goods2.goods_begin_time is null then session2.auction_session_begin_time else goods2.goods_begin_time end),
			          	goods2.vehicle_id
		      	) deal_vehicle
		 	on deal_vehicle.vehicle_id = all_vehicle.vehicle_id
	        and deal_vehicle.auction_time = toDate(all_vehicle.auction_time)
	        where all_vehicle.goods_status in (0, 1, 2, 3)
	        and deal_vehicle.vehicle_id = 0 -- 排除当日有成交车辆
		) undeal_auction
	where undeal_auction.row_rank = 1
	union all
	select
	  deal_auction.id -- 取当日成交车辆
	from
	  db_youliangpai.yl_auction_goods_info deal_auction
	final
	where deal_auction.goods_status = 2
	and deal_auction._sign = 1
	and deal_auction.is_deleted = 0
),
auctioin_order_curday as--当日参拍顺序
(
	select
		  goods.id as auction_id,
	      ROW_NUMBER () over
	      	(PARTITION by goods.vehicle_id,toDate(case when goods.goods_begin_time is null then sessions.auction_session_begin_time else goods.goods_begin_time end) order by
	          case
	            when goods.goods_begin_time is null then sessions.auction_session_begin_time
	            else goods.goods_begin_time
	          end asc
	      	) as auctioin_order_curday --当日参拍顺序
	    from
	      db_youliangpai.yl_auction_goods_info goods
	    final
	  	left join 
	  		(
		        select
					session_id,
					session_auction_type,
		          	online_auction_type,
					auction_session_begin_time
				from syncdb.dim_yl_auction_session_tmp
				where is_deleted = 0
	      	) sessions 
		on sessions.session_id = goods.auction_session_id
	    where goods._sign = 1
	  	and goods.is_deleted = 0
	  	and goods.goods_status in (0, 1, 2, 3)
),
auction_order_acc as --累积参拍顺序（每日参拍多次算一次）
(
	select
	      vehicle_id,
	      auction_time,
	      ROW_NUMBER () over(PARTITION by vehicle_id order by auction_time) as auction_order_acc--累积参拍顺序
	    from(
	        select
	          goods.vehicle_id,
	          formatDateTime(case when goods.goods_begin_time is null then sessions.auction_session_begin_time else goods.goods_begin_time end,'%Y-%m-%d') auction_time
	        from db_youliangpai.yl_auction_goods_info goods
	        final
	      	left join 
	      		(
		            select
						session_id,
						session_auction_type,
			          	online_auction_type,
						auction_session_begin_time
					from syncdb.dim_yl_auction_session_tmp
					where is_deleted = 0
	          	) sessions
	     	on sessions.session_id = goods.auction_session_id
	        where goods._sign = 1
		    and goods.is_deleted = 0
		    and goods.goods_status in (0, 1, 2, 3)
	        group by
	          goods.vehicle_id,
	          formatDateTime(case when goods.goods_begin_time is null then sessions.auction_session_begin_time else goods.goods_begin_time end,'%Y-%m-%d')
	      ) auction_order_acc_sub
),
auction_user_cnt as--参拍人数
(
	select 
		auction.vehicle_auction_id--竞拍ID
	   ,fee.auction_user_cnt--参拍人数(人车比)
	from
		(
			select 
				goods.id as vehicle_auction_id
			   ,goods.`service_centre_id` as centre_id
			   ,formatDateTime(case when goods.goods_begin_time is null then sessions.auction_session_begin_time else goods.goods_begin_time end  ,'%Y-%m-%d')  as auction_time
			   ,ROW_NUMBER()over(PARTITION by goods.`service_centre_id` ,formatDateTime(case when goods.goods_begin_time is null then sessions.auction_session_begin_time else goods.goods_begin_time end  ,'%Y-%m-%d') 
				order by case when goods.goods_begin_time is null then sessions.auction_session_begin_time else goods.goods_begin_time end ) as ascending_order-- 升序
			from db_youliangpai.yl_auction_goods_info goods
			left join auction_cnt auction_cnt_t
			on goods.id=auction_cnt_t.id 
			left join 
				(
					 select
						session_id,session_auction_type,auction_session_begin_time,online_auction_type,auction_session_name
					from syncdb.dim_yl_auction_session_tmp
					where is_deleted = 0
				) sessions
			on sessions.session_id=goods.auction_session_id
			left join
				(
					select
						distributor_id,group_id,distributor_full_name,third_distributor_code
					from syncdb.dim_yl_distributor_tmp
					where is_deleted=0
				) distributor_t
			on goods.distributor_id = distributor_t.group_id
			left join
				(
					select
						vehicle_code,
						estimated_price
					from
						syncdb.dim_yl_vehicle_tmp
				) v
			on goods.vehicle_code = v.vehicle_code
			left join
				(
					select 
						goods_id,
						vehicle_tag
					from 
						db_youliangpai.yl_member_car_info 
					final 
					where `_sign`=1
				) tags
			on goods.id = tags.goods_id
			where auction_cnt_t.id >0 and (sessions.session_auction_type=1 or sessions.online_auction_type in ('普通拍','专场拍'))
			and goods.service_centre_name not like '%专享%'--排除专享车
--			and 
--				multiIf(toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%品质%','刷数',
--						toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%精品%','刷数',
--						toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%高品%','刷数',
--						toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%高值%','刷数',
--						toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%专场%','刷数',
--						toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%本品车%','刷数',
--						toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%加拍%','刷数',
--						toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%加场拍%','刷数',
--						auction_session_id = 8131,'刷数',
--						auction_session_id = 8841,'刷数',
--						goods.goods_status in (0,1,3) 
--						and toDate(sessions.auction_session_begin_time) > '2023-10-31' 
--						and toDate(sessions.auction_session_begin_time) <= '2023-11-30'
--						and sessions.session_auction_type = 2
--						and sessions.auction_session_name like '%昆明%','刷数',
--						goods.goods_status in (0,1,3) 
--						and toDate(sessions.auction_session_begin_time) > '2024-04-17'
--						and toDate(sessions.auction_session_begin_time) < '2024-07-01'
--						and v.estimated_price >= 100000,'刷数',
--						toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3)
--						and position(tags.vehicle_tag,'3',1)>0,'刷数',
--						toDate(sessions.auction_session_begin_time) >= '2024-07-01' and position(tags.vehicle_tag,'3',1)>0 and sessions.online_auction_type <> '享辆拍' and distributor_t.group_id = 95,'刷数',
--						goods.goods_status in (4,5),NULL,
--						 '非刷数') = '非刷数'
		) auction
	left join
		(
		    select 
		    	operate_time
	           ,centre_id
	           ,count(distinct member_id) as auction_user_cnt--参拍人数(人车比)
		    from
		    	(
					select 
						formatDateTime(auction_fee.created_time,'%Y-%m-%d') as operate_time
				       ,auction_fee.user_id as member_id
				       ,goods.`service_centre_id`  as centre_id
					from db_youliangpai.yl_member_auction_fee_info auction_fee
					final
					left join 
						(
							select member_id from import_data_db.b2_virtual_account_detail
						) virtual_account
					on auction_fee.user_id = virtual_account.member_id
					left join 
						(select id,service_centre_id,service_centre_name,auction_session_id,vehicle_code,goods_status,distributor_id from db_youliangpai.yl_auction_goods_info final where `_sign`=1 and is_deleted=0 )  goods 
					on goods.id =auction_fee.goods_id
					left join
						(
							select
								session_id,session_auction_type,auction_session_begin_time,online_auction_type,auction_session_name
							from syncdb.dim_yl_auction_session_tmp
							where is_deleted = 0
						) sessions
					on sessions.session_id=goods.auction_session_id
					left join
						(
							select
								distributor_id,group_id
							from syncdb.dim_yl_distributor_tmp
							where is_deleted=0
						) distributor_t
					on goods.distributor_id = distributor_t.group_id
					left join
						(
							select
								vehicle_code,
								estimated_price
							from
								syncdb.dim_yl_vehicle_tmp
						) v
					on goods.vehicle_code = v.vehicle_code
					left join
						(
							select 
								goods_id,
								vehicle_tag
							from 
								db_youliangpai.yl_member_car_info 
							final 
							where `_sign`=1
						) tags
					on goods.id = tags.goods_id
					where auction_fee.`_sign`=1 and auction_fee.is_deleted=0 and auction_fee.`is_valid`=0 and auction_fee.bid_method !=2--排除线下拍卖师
					and  LENGTH (goods.`service_centre_name`)>0
--					and virtual_account.member_id is null--剔除 顶价人员
					and (sessions.session_auction_type=1 or sessions.online_auction_type in ('普通拍','专场拍'))--剔除 享辆拍
					and goods.service_centre_name not like '%专享%'--剔除 专享车
					and multiIf(toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%品质%','刷数',
								toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%精品%','刷数',
								toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%高品%','刷数',
								toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%高值%','刷数',
								toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%专场%','刷数',
								toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%本品车%','刷数',
								toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%加拍%','刷数',
								toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3) and sessions.auction_session_name like '%加场拍%','刷数',
								goods.auction_session_id = 8131,'刷数',
								goods.auction_session_id = 8841,'刷数',
								goods.goods_status in (0,1,3) 
								and toDate(sessions.auction_session_begin_time) > '2023-10-31' 
								and toDate(sessions.auction_session_begin_time) <= '2023-11-30'
								and sessions.session_auction_type = 2
								and sessions.auction_session_name like '%昆明%','刷数',
								goods.goods_status in (0,1,3) 
								and toDate(sessions.auction_session_begin_time) > '2024-04-17'
								and toDate(sessions.auction_session_begin_time) < '2024-07-01'
								and v.estimated_price >= 100000,'刷数',
								toDate(sessions.auction_session_begin_time) < '2024-07-01' and goods.goods_status in (0,1,3)
								and position(tags.vehicle_tag,'3',1)>0,'刷数',
								toDate(sessions.auction_session_begin_time) >= '2024-07-01' and position(tags.vehicle_tag,'3',1)>0 and sessions.online_auction_type <> '享辆拍' and distributor_t.group_id = 95,'刷数',
								goods.goods_status in (4,5),NULL,
								 '非刷数') = '非刷数'--剔除 刷数车
					group by 
						formatDateTime(auction_fee.created_time,'%Y-%m-%d')
				       ,auction_fee.user_id 
				       ,goods.`service_centre_id`
					union all 
					select 
						formatDateTime(created_time,'%Y-%m-%d') operate_time
					    ,member_id
					    ,centre_id
					from db_youliangpai.yl_session_sign_info 
					final
					where `_sign`=1 and is_deleted=0
				) fee_user
			group by operate_time
		           ,centre_id
		) fee
	on fee.operate_time = auction.auction_time and fee.centre_id=auction.centre_id
	where auction.ascending_order=1
)

select
	auction_goods.id vehicle_auction_id,--竞拍ID
	session_t.session_id,--场次ID
	session_t.auction_session_name,--场次名称
	session_t.session_auction_type_value,--竞拍规则
	session_t.auction_session_code,--场次编码
	session_t.auction_duration,--竞拍时长
	session_t.auction_interval,--竞拍间隔
	session_t.auction_session_begin_time,
	session_t.session_final_number,--场次车辆数
	session_t.bid_security,
	session_t.transfer_deposit,
	session_t.nonmember_visible,
	session_t.online_auction_type,--场次类型
	vehicle.vehicle_id,--车辆ID
	vehicle.vehicle_code,--车辆编码
	vehicle.create_time,--车辆创建时间
	vehicle.create_id,--车辆创建者ID
	vehicle.vin_code,--车架号
	vehicle.vehicle_plate_number,--车牌号
	vehicle.vehicle_brand,--车辆品牌
	vehicle.vehicle_series,--车系
	vehicle.vehicle_series_code,
	vehicle.vehicle_name,--车型
	vehicle.vehicle_kilometers,--表显里程数(万)
	vehicle.transfer_count,--过户次数
	date_diff('month',toDateTime(vehicle.vehicle_registration_date),toDateTime(today()))/12 vehicle_age,--车龄
	vehicle.vehicle_energy_type,--能源类型
	vehicle.vehicle_displacement,--排量
	vehicle.vehicle_source,--车辆来源
	vehicle.vehicle_nature,--车辆性质
	vehicle.vehicle_used_type,--使用性质
	vehicle.estimated_price,--预估价(万)
	vehicle.vehicle_registration_date,--登记日期
	vehicle.vehicle_manufacturing_date,--出厂日期
	vehicle.vehicle_trafficinsurance_date,--交强险到期时间
	vehicle.vehicle_commercial_insurance_date,--商业险到期时间
	vehicle.vehicle_annual_inspection_date,--年检到期日
	vehicle.vehicle_belong_city,--车辆归属地城市
	vehicle.vehicle_belong_province,--车辆归属地省份
	vehicle.vehicle_location_city,--车辆所在地城市
	vehicle.vehicle_location_province,--车辆所在地省份
	vehicle.three_way_catalyst_value,--三元催化
	vehicle.report_rating,--报告等级
	vehicle.report_url,--报告地址
	vehicle.appraiser,--评估师
	vehicle.free_worry_detection,--是否有辆检
	vehicle.vehicle_detection_method,--检测方式
	multiIf(
				vehicle.is_major_accident = 0,'否',vehicle.is_major_accident = 1,'是',null
	) is_major_accident_value,--是否重大事故
	distributor.distributor_id,--委托方ID
	distributor.distributor,--委托方名称
	distributor.distributor_code,--委托方编码
	distributor.distributor_province_name,--委托方所在省份
	distributor.distributor_city_name,--委托方所在市
	distributor.distributor_brand,--委托方品牌
	distributor.distributor_created_time,--委托方创建时间
	distributor.first_valid_auction_time,--委托方首次参拍时间
	distributor.distributor_full_name,
	distributor.is_delivery_money_value,
	distributor.service_centre_name,--委托方归属中心
	distributor.third_distributor_code,
	group_t.group_id,--集团ID
	group_t.group_name,--集团名称
	centre.centre_id,--中心ID
	centre.centre_name,--中心名称
	centre.centre_type,--中心类型
	centre.centre_contact_name,--中心联系人
	order_t.member_id,--会员ID
	mem.member_name,--会员姓名
	mem.membership,--入会状态
	mem.member_director,--维护顾问
	mem.service_centre_name,--会员归属中心
	mem.member_mobile_phone,--会员手机号
	mem.id_number,--身份证号
	agent.vehicle_migrate_city,--车辆迁往地城市
    agent.vehicle_migrate_province,--车辆迁往地省份
    agent.agency_name,
    agent.procedure_return_time,
    agent.transfer_completion_time,
    order_t.is_authenticated,--是否保真
    case when auction_goods.goods_begin_time is null then session_t.auction_session_begin_time else auction_goods.goods_begin_time end as auction_time,--参拍时间
    auction_goods.goods_status,--参拍状态
	auction_goods.starting_auction_price,--起拍价
	auction_goods.retention_price,--保留价
	order_t.car_price deal_price,--成交价
	auction_goods.aborted_fee,--流拍价
	case when auction_goods.goods_status = '成交' and (order_t.discount_amount is null or order_t.discount_amount = 0) then auction_goods.vehicle_price when auction_goods.goods_status = '成交' and order_t.discount_amount > 0 then order_t.discount_amount + auction_goods.vehicle_price else 0
    end as deal_amount,--成交额
    multiIf(
    			auction_goods.set_discount_type != '无' and auction_goods.goods_status = '成交' and order_t.discount_type = '无补贴','无补贴',
    			auction_goods.set_discount_type != '无' and auction_goods.goods_status = '成交' and order_t.discount_amount>0 and order_t.discount_type = '自动补贴','自动补贴',
    			auction_goods.set_discount_type != '无' and auction_goods.goods_status = '成交' and order_t.discount_amount>0 and order_t.discount_type = '出价补贴','出价补贴',
    			null
    ) discount_type,--订单补贴促销类型
    auction_goods.set_discount_type,--设置补贴类型
	case
        when auction_goods.goods_status = '成交'
        and order_t.discount_amount is null then 0
        else order_t.discount_amount
  	end as discount_amount,--补贴金额
--  	coupon.coupon_name,--优惠券名字
  	toInt64(order_t.coupon_id),
	case
	    when auction_goods.goods_status = '成交'
	    and order_t.coupon_price is null then 0
	    else order_t.coupon_price
  	end as coupon_price,--优惠券金额
	auction_goods.goods_type,--车辆类型
	v_source.dict_label vehicle_data_sources,--车辆上拍来源
	auction_goods.deal_type,--成交方式
	auction_goods.created_time,
	order_t.vehicle_order_status,--订单状态
	order_t.vehicle_order_code,--订单编号
	order_t.transfer_method,--代办方式
	order_t.transfer_status,--过户状态
	multiIf(order_t.is_dispute = 1,'是',
					 '否') AS 
	is_dispute,--是否争议
	COALESCE(if(order_t.order_created_time = '1970-01-01 08:00:00.000',null,order_t.order_created_time),if(agent.agent_modified_time = '1970-01-01 08:00:00.000',null,agent.agent_modified_time)),--过户状态创建时间
--	if(agent.agent_modified_time is null,order_t.order_created_time,agent.agent_modified_time),--过户状态创建时间
	agent.agent_modified_time,--过户状态变更时间
	v_tag.transfer_requirements,--过户条件
	if(auction_goods.goods_status = '成交' and order_detail.commission is NULL,0,order_detail.commission) commission,--佣金
	if(auction_goods.goods_status = '成交' and order_detail.delivery_fee is NULL,0,order_detail.delivery_fee) delivery_fee,--交付费
	if(auction_goods.goods_status = '成交' and fee.`交付费` is NULL,0,fee.`交付费`) delivery_fee_set,--交付费设置金额
	if(auction_goods.goods_status = '成交' and order_detail.check_fee is NULL,0,order_detail.check_fee) check_fee,--检测费
	if(auction_goods.goods_status = '成交' and order_detail.storage_fee is NULL,0,order_detail.storage_fee) storage_fee,--仓储费
	-- if(auction_goods.goods_status = '成交' and order_detail.group_mgt_fee is NULL,0,order_detail.group_mgt_fee) group_mgt_fee,--集团管理费
    if(
        auction_goods.goods_status = '成交',if(session_t.online_auction_type = '享辆拍',ifNull(order_detail.group_mgt_fee_xlp,0) +ifNull(order_detail.group_mgt_fee_jsp,0),ifNull(order_detail.group_mgt_fee_jsp,0)),0) group_mgt_fee,--集团管理费
--	if(auction_goods.goods_status = '成交' and order_detail.vehicle_source_service_fee is NULL,0,order_detail.vehicle_source_service_fee) vehicle_source_service_fee,--车源服务费
	if(auction_goods.goods_status = '成交',if(session_t.online_auction_type = '享辆拍',ifNull(order_detail.vehicle_source_service_fee_xlp,0) +ifNull(order_detail.vehicle_source_service_fee,0),ifNull(order_detail.vehicle_source_service_fee,0)),0) vehicle_source_service_fee,--车源服务费
	if(auction_goods.goods_status = '成交' and order_detail.other_fee is NULL,0,order_detail.other_fee) other_fee,--其他费用
	if(auction_goods.goods_status = '成交' and order_detail.agency_fee is NULL,0,order_detail.agency_fee) agency_fee,--代理费
	-- if(auction_goods.goods_status = '成交' and order_detail.sys_use_fee is NULL,0,order_detail.sys_use_fee) sys_use_fee,--系统使用费
      if(auction_goods.goods_status = '成交',if(session_t.online_auction_type = '享辆拍',ifNull(order_detail.sys_use_fee_xlp,0) +ifNull(order_detail.sys_use_fee_jsp,0),ifNull(order_detail.sys_use_fee_jsp,0)),0) sys_use_fee,--系统使用费
	order_t.total_order_amount,--成交总价
	order_t.collection_number,--收款单号
	pay.collection_code,--收款单据号
	if(order_t.vehicle_auction_id is null,null,order_t.order_created_time),--订单时间
	order_detail.commission + order_detail.check_fee + order_detail.storage_fee income,--收入
	case when order_t.vehicle_order_status= '交易取消' and  order_t.return_time is null then quarel.dispute_created_time else  order_t.return_time end as return_vehicle_time,--退车时间
	order_t.modified_time,
	order_t.return_time,
	order_t.invoicing_time,--进销存时间
	order_t.service_centre_id,
	order_t.pay_user_name,
	if(pay.pay_type = 4,pay.payment_modified_time,pay.payment_time) collection_time,--收款日期
	pay.payment_time,--付款时间
	pay.transfer_date,--运营点实际收款
	if(pay.pay_type = 3,order_t.total_order_amount- if(order_t.coupon_price is null,0,order_t.coupon_price),0) remittance,--汇款
	if(pay.pay_type = 4,order_t.total_order_amount-if(order_t.coupon_price is null,0,order_t.coupon_price),0) ping_amt,--PING++
	if(pay.amount_received is null,0,pay.amount_received) collection_amt_total,--收款合计
	if(pay.pay_type = 1, pay.amount_received,null) wechat_pay_amt,--微信支付
	if(pay.pay_type = 2, pay.amount_received,null) alipay_amt,--支付宝支付金额
--	multiIf(
--			pay.pay_type = 3,'星空提报',
--			pay.pay_type = 4 and client.client_name = '苏州辙远信息科技有限公司','星空提报',
--			pay.pay_type = 4 and client.client_name = '','星空提报',
--			pay.pay_type = 4 and client.client_name = '其他','自动分账',
--			NULL
--	) AS is_xktb,--是否星空提报
	quarel.dispute_time,
	multiIf(quarel.dispute_type=1,'车况类',quarel.dispute_type=2,'交易类',quarel.dispute_type=3,'过户类',
	        quarel.dispute_type=4,'手续类',quarel.dispute_type=5,'说明类',
	        NULL
	) AS dispute_type,
	multiIf(quarel.responsible_party=1,'无责任方',quarel.responsible_party=2,'买家方责任',quarel.responsible_party=3,'卖家方责任',
	        quarel.responsible_party=4,'拍卖中心责任',quarel.responsible_party=5,'代办责任',quarel.responsible_party=6,'代驾责任',
	        NULL
	) AS responsible_party,
	quarel.continue_trading,
	multiIf(toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%品质%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%精品%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%高品%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%高值%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%专场%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%本品车%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%加拍%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%加场拍%','刷数',
		auction_session_id = 8131,'刷数',
		auction_session_id = 8841,'刷数',
		auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') 
		and toDate(session_t.auction_session_begin_time) > '2023-10-31' 
		and toDate(session_t.auction_session_begin_time) <= '2023-11-30'
		and session_t.session_auction_type = 2
		and session_t.auction_session_name like '%昆明%','刷数',
		auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') 
		and toDate(session_t.auction_session_begin_time) > '2024-04-17'
		and toDate(session_t.auction_session_begin_time) < '2024-07-01'
		and vehicle.estimated_price >= 100000,'刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍')
		and position(v_tag.vehicle_tag,'3',1)>0,'刷数',
		toDate(session_t.auction_session_begin_time) >= '2024-07-01' and position(v_tag.vehicle_tag,'3',1)>0 and session_t.online_auction_type <> '享辆拍' and group_t.group_id = 95,'刷数',
		auction_goods.goods_status in ('撤拍', '取消参拍'),NULL,
		 '非刷数') AS is_brush_num,--是否刷数
	multiIf(toDate(session_t.auction_session_begin_time) < '2024-07-01' and session_t.auction_session_name like '%品质%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and session_t.auction_session_name like '%精品%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and session_t.auction_session_name like '%高品%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and session_t.auction_session_name like '%高值%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and session_t.auction_session_name like '%专场%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and session_t.auction_session_name like '%本品车%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and session_t.auction_session_name like '%加拍%','刷数',
		toDate(session_t.auction_session_begin_time) < '2024-07-01' and session_t.auction_session_name like '%加场拍%','刷数',
		auction_session_id = 8131,'刷数',
		auction_session_id = 8841,'刷数',
		toDate(session_t.auction_session_begin_time) > '2023-10-31' 
		and toDate(session_t.auction_session_begin_time) <= '2023-11-30'
		and session_t.session_auction_type = 2
		and session_t.auction_session_name like '%昆明%','刷数',
		toDate(session_t.auction_session_begin_time) > '2024-04-17' and toDate(session_t.auction_session_begin_time) < '2024-07-01'
		and vehicle.estimated_price >= 100000,'刷数',
		toDate(session_t.auction_session_begin_time) >= '2024-07-01' and position(v_tag.vehicle_tag,'3',1)>0 and session_t.online_auction_type <> '享辆拍' and group_t.group_id = 95,'刷数',
		auction_goods.goods_status in ('撤拍', '取消参拍'),NULL,
		 '非刷数') AS is_brush_num_deal,--是否刷数(成交)
	multiIf(auction_cnt.id > 0 and auction_goods.vehicle_id = 64926,10,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 64913,9,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 64919,8,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 65117,10,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 65661,10,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 65647,10,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 66305,9,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 66311,7,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 66313,11,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 66316,10,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 66319,10,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 67106,11,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 67107,10,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 67109,10,
		auction_cnt.id > 0 and auction_goods.vehicle_id = 67110,10,
		auction_cnt.id > 0,1,
		0) AS auction_cnt,--参拍量
	auctioin_fee.bid_cnt,--出价次数
	auctioin_fee.bid_user_cnt,--出价人数
	multiIf(auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 64926,10,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 64913,9,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 64919,8,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 65117,10,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 65661,10,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 65647,10,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 66305,9,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 66311,7,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 66313,11,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 66316,10,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 66319,10,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 67106,11,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 67107,10,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 67109,10,
		auction_goods.goods_status = '成交' and auction_goods.vehicle_id = 67110,10,
		auction_goods.goods_status = '成交',1,
		0) AS deal_cnt,--成交量
	auctioin_order_curday.auctioin_order_curday,--当日参拍顺序
	auction_order_acc.auction_order_acc,--累积参拍顺序
	ROW_NUMBER() over(PARTITION by vin_code order by auction_time) auction_order_his,--历史参拍顺序
	multiIf(auction_goods.goods_status = '成交',100,
		NULL) AS forecast_delivery_profit,--预估交付费利润
	multiIf(group_t.group_id = 95 and auction_goods.goods_status = '成交',200,
        group_t.group_id <> 95 and auction_goods.goods_status = '成交',0,
		NULL) AS forecast_vehicle_source_fee,--预估车源费
	favourite.fav_cnt,--关注人数,
	v_tag.vehicle_tag,--辆典车
	auction_user_cnt.auction_user_cnt,--参拍人数(人车比)
	host.group_name,--主机厂
	vehicle.manufacturers,--厂家
	case when auction_goods.goods_status = '成交' and session_t.online_auction_type = '享辆拍' then 0
--	     when auction_goods.goods_status = '成交' and 
--	     	multiIf(toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%品质%','刷数',
--					toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%精品%','刷数',
--					toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%高品%','刷数',
--					toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%高值%','刷数',
--					toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%专场%','刷数',
--					toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%本品车%','刷数',
--					toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%加拍%','刷数',
--					toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') and session_t.auction_session_name like '%加场拍%','刷数',
--					auction_session_id = 8131,'刷数',
--					auction_session_id = 8841,'刷数',
--					auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') 
--					and toDate(session_t.auction_session_begin_time) > '2023-10-31' 
--					and toDate(session_t.auction_session_begin_time) <= '2023-11-30'
--					and session_t.session_auction_type = 2
--					and session_t.auction_session_name like '%昆明%','刷数',
--					auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍') 
--					and toDate(session_t.auction_session_begin_time) > '2024-04-17'
--					and toDate(session_t.auction_session_begin_time) < '2024-07-01'
--					and vehicle.estimated_price >= 100000,'刷数',
--					toDate(session_t.auction_session_begin_time) < '2024-07-01' and auction_goods.goods_status in ('待竞拍', '竞拍中', '流拍')
--					and position(v_tag.vehicle_tag,'3',1)>0,'刷数',
--					toDate(session_t.auction_session_begin_time) >= '2024-07-01' and position(v_tag.vehicle_tag,'3',1)>0 and session_t.online_auction_type <> '享辆拍' and group_t.group_id = 95,'刷数',
--					auction_goods.goods_status in ('撤拍', '取消参拍'),NULL,
--					 '非刷数') = '刷数' then 0
		when auction_goods.goods_status = '成交' and order_t.transfer_method = '非代办' then 0
		when auction_goods.goods_status = '成交' and order_t.transfer_method = '代办' and settle_accounts_fee.settle_accounts_fee >0 then settle_accounts_fee.settle_accounts_fee
		when auction_goods.goods_status = '成交' and order_t.transfer_method = '代办' and settle_accounts_fee.settle_accounts_fee is null then 0
		else null
	end as settle_accounts_fee,--交付费结算金额
--	settle_accounts_fee.settle_accounts_fee,--交付费结算金额
	vehicle.starting_price,
	vehicle.end_price,
	goods_begin_time,
	goods_end_time,
	free_margin,
	freeze_margin,
	total_margin_amount,
	pay.pay_type,
	order_t.vehicle_package_count,
	now()
			
from
	(
		select
			id,vehicle_id,vehicle_code,distributor_id,auction_session_id,service_centre_id,
			starting_auction_price,retention_price,vehicle_price,aborted_fee,vehicle_price,
			goods_begin_time,is_auction_number,created_time,
			multiIf(goods_type = 1,'二手车',
					goods_type = 2,'新车',
					goods_type = 3,'车辆包',
					goods_type = 4,'摩托车',
					 '其他') AS goods_type,
			vehicle_data_sources,
			multiIf(goods_status = 0,'待竞拍',
					goods_status = 1,'竞拍中',
					goods_status = 2,'成交',
					goods_status = 3,'流拍',
					goods_status = 4,'撤拍',
					goods_status = 5,'取消参拍',
					 '其他') AS goods_status,
			multiIf(goods_status = '成交' and is_auction_number = 1,'现场',
					goods_status = '成交' and is_auction_number = 0,'线上',
					NULL) AS deal_type,
			goods_begin_time,
			goods_end_time,
			can_subsidydeal,--1不允许2允许
			subsidy_amount,--成交补贴金额
			multiIf(
						can_subsidydeal = 2 and subsidy_promotion_type = 1,'自动补贴',can_subsidydeal = 2 and subsidy_promotion_type = 2,'出价补贴','无'
			) set_discount_type--设置补贴类型
		from db_youliangpai.yl_auction_goods_info
		final
		where
			_sign=1 and is_deleted=0
	) auction_goods--参拍明细
left join
	(
		select
	      vehicle_auction_id,
	      t1.order_code vehicle_order_code,
	       multiIf(transfer_method = 1,'代办',
					transfer_method = 2,'非代办',
					 NULL)
	      transfer_method,
	      multiIf(transfer_status = 1,'待过户',
					transfer_status = 2,'过户中',
					transfer_status = 3,'已过户',
					transfer_status = 4,'手续已上传',
					transfer_status = 5,'驳回',
					transfer_status = 6,'手续已确认',
					 NULL) AS transfer_status,
	      transfer_requirements,
	      t0.buyer_id member_id,
	      t0.buyer_name member_name,
	      return_time,
	      t0.discount_amount discount_amount,
	      coupon_id,
	      coupon_price,
	      t0.modified_time modified_time,
	      multiIf(order_status = 1,'待付款',
					order_status = 2,'付款中',
					order_status = 3,'付款完成',
					order_status = 4,'交易完成',
					order_status = 5,'交易取消',
					 NULL) AS vehicle_order_status,--订单状态
			is_dispute,
			t0.create_time order_created_time,
			total_order_amount,
			collection_number,
			case when vehicle_order_status <> '交易取消' then order_created_time
				 when vehicle_order_status= '交易取消' and return_time is not null and toStartOfMonth(order_created_time)=toStartOfMonth(return_time)  then order_created_time
				 when vehicle_order_status= '交易取消' and return_time is null and toStartOfMonth(order_created_time)=toStartOfMonth(modified_time)  then order_created_time
				 when vehicle_order_status= '交易取消' and return_time is not null and toStartOfMonth(order_created_time)<>toStartOfMonth(return_time)  then return_time
				 when vehicle_order_status= '交易取消' and return_time is null and toStartOfMonth(order_created_time)<>toStartOfMonth(modified_time)  then return_time
				else null 
			end invoicing_time,
			t5.service_centre_id service_centre_id,
			buyer_name pay_user_name,
			t1.car_price car_price,
			multiIf(t0.subsidy_promotion_type =0,'无补贴',
					t0.subsidy_promotion_type =1,'自动补贴',t0.subsidy_promotion_type=2,'出价补贴',null
			) discount_type,--补贴类型
			vehicle_package_count,
			if(t6.transfer_ownership_id is null,null,'是') is_authenticated
	    from 
	    	(
	    		select *
	    		from db_mp_order.order_info
	    		final
	    		where _sign = 1 and order_type = 0
	    		and source = 0
	    	) t0
	    left join 
	    	(
	    		select *
	    		from db_mp_order.order_goods_items
	    		final
	    		where _sign = 1
	    	) t5
	    on t0.id = t5.order_id
	    left join 
	    	(
	    		select *
	    		from db_mp_order.car_order_goods_items
	    		final
	    		where _sign = 1
	    	) t1
	   	on t1.order_id = t5.order_id 
	   	and t1.vehicle_id = t5.product_id
	    left join 
	    	(
	    		select *
	    		from db_mp_order.transfer_ownership_info
	    		final
	    		where _sign = 1
	    	) t2
	    on t1.order_code = t2.order_code
	    left join
	    	(
	    		select target_id,discount_amount,coupon_id
	    		from db_mp_order.discount_record
	    		final
	    		where _sign = 1 and target_type = 1 and is_delete=0
	    	) t3
	    on t1.order_id = t3.target_id
	   	left join
	   		(
	   			select
	   				order_id,order_goods_item_id,t4a.collection_number collection_number
	   			from
	   				(
	   					select
	   						collection_number
	   					from db_mp_order.payment_order
	   					final
	    				where _sign = 1 and  payment_receipt_type = 1--收款
	   				) t4a
	   			join 
	   				(
	   					select order_id,order_goods_item_id,collection_number
			   			from db_mp_order.payment_order_relation
			   			final
	    				where _sign = 1 and is_delete=0
	   				) t4b
	   			on t4a.collection_number = t4b.collection_number
	   		) t4
	   	on t1.order_id = t4.order_id and t5.id = t4.order_goods_item_id
	   	left join
	   		(
	   			select
					transfer_ownership_id
				from db_mp_order.transfer_ownership_details
				final
				where _sign = 1
				and sub_code = 'isAuthenticated-1' --保真
				and value = '1'
				group by transfer_ownership_id
	   		) t6--保真
	   	on t2.id = t6.transfer_ownership_id
	) order_t--订单主表
on auction_goods.id = order_t.vehicle_auction_id
left join
	(
	   select `order_code` vehicle_order_code
          ,max(case when `fee_code`='F0001' then `price`else 0 end) as `commission`--`佣金`
          ,max(case when `fee_code`='F0002' then `price` else 0 end) as `delivery_fee`--`交付费`
          ,max(case when `fee_code`='F0003' then `price` else 0 end) as `check_fee`--`检测费`
          ,max(case when `fee_code`='F0004' then `price` else 0 end) as `storage_fee`--`仓储费`
          ,max(case when id<=1106915 and cost_type=4 then `price`
                    when id>1106915 then 0
                    else 0 
               end) as `group_mgt_fee_jsp`--`集团管理费`
          ,max(case when `fee_code`='F0009' then `price` else 0 end) as `other_fee`--`其他费用`
          ,max(case when id<=1106915 and cost_type=6 then `price`
                     when id>1106915 and `fee_code`='F0006' then `price` else 0 
               end) as `sys_use_fee_jsp`--`系统服务费`
          ,max(case when id<=1106915 and cost_type=9 then `price`
                    when id>1106915 and `fee_code`='F0005' then `price` 
                    else 0 
               end) as `vehicle_source_service_fee`--`车源服务费(即时拍)`
          ,max(case when id<=1106915 and cost_type=11 then `price` 
                    when id>1106915 then 0
                    else 0 
               end) as `vehicle_source_service_fee_xlp`--`车源服务费(享辆拍)`
          ,max(case when id<=1106915 and cost_type=12 then `price` 
                    when id>1106915 then 0
                    else 0 
              end) as `group_mgt_fee_xlp`--`集团管理费(享辆拍)`
          ,max(case when id<=1106915 and cost_type=13 then `price` 
                    when id>1106915 then 0
                    else 0 
              end) as `sys_use_fee_xlp`--`系统服务费(享辆拍)`
          ,max(case when `fee_code`='F0008' then `price` else 0 end) as `agency_fee`--`代理费`        
   from db_mp_order.goods_expense_items final
   where  `_sign`=1 
   group by `order_code`
	) order_detail--订单明细
on order_t.vehicle_order_code = order_detail.vehicle_order_code	
--left join
--	(
--		select
--		  id,name coupon_name
--		from db_youliangpai.yl_coupon_policy_type 
--		final		
--		where _sign = 1
--	) coupon
--on order_t.coupon_id = coupon.id
left join
	(
		select *
		from
			(
				select
		          order_code vehicle_order_code,
		          if(city = '',Null,city) vehicle_migrate_city,--车辆迁往地城市
		          if(province = '',Null,province) vehicle_migrate_province,--车辆迁往地省份
		          modified_time agent_modified_time,
		          agency_name,--代办公司名称
		          agency_id,
		          procedure_return_time,--过户手续上传时间
		          transfer_completion_time,
		          row_number() over(partition by vehicle_order_code order by id) rk
		        from db_mp_order.transfer_ownership_info
		        final
	    		where _sign = 1
			) agent1
		where rk = 1
	) agent--代办
on order_t.vehicle_order_code = agent.vehicle_order_code
left join
	(
		select
			id
		from auction_cnt
	) auction_cnt--参拍量
on auction_goods.id = auction_cnt.id
left join
	(
		select
          goods_id,
          count(id) bid_cnt,--出价次数
          count(distinct user_id) bid_user_cnt--出价人数
        from
          db_youliangpai.yl_member_auction_fee_info 
        final
        where _sign = 1
        and is_deleted = 0
        and is_valid =0 --出价有效
        and bid_method !=2--排除线下拍卖师
        group by
          goods_id
	) auctioin_fee--喊价
on auction_goods.id = auctioin_fee.goods_id
left join auctioin_order_curday--当日参拍顺序
on auction_goods.id = auctioin_order_curday.auction_id
left join
	(
		select
			session_id,auction_session_name,session_auction_type,session_auction_type_value,auction_session_begin_time,online_auction_type
			,auction_duration,auction_interval,auction_session_code,session_final_number,nonmember_visible,bid_security,transfer_deposit
		from syncdb.dim_yl_auction_session_tmp
		where is_deleted = 0
	) session_t--场次维度
on auction_goods.auction_session_id = session_t.session_id
left join auction_order_acc--累积参拍顺序
on auction_goods.vehicle_id = auction_order_acc.vehicle_id
and formatDateTime(case when auction_goods.goods_begin_time is null then session_t.auction_session_begin_time else auction_goods.goods_begin_time end,'%Y-%m-%d') = auction_order_acc.auction_time
left join
	(
		select
			vehicle_order_code,
			dispute_time,
			dispute_created_time,
			dispute_type,
			responsible_party,
			continue_trading
		from
			(
				select 
					order_code vehicle_order_code,
					created_time dispute_created_time,
					modified_time dispute_time,
					after_sales_type dispute_type,--争议类别
					responsible_party,--责任方
					if(continue_trading=1,'继续交易','交易取消') continue_trading,
					ROW_NUMBER()over(PARTITION by order_code order by modified_time desc) rk
				from db_mp_order.after_sales_support
				final
				where _sign = 1 and toDate(modified_time) != '2024-02-07'
			) quarel_sub
		where rk = 1
	) quarel --争议(退车)表
on order_t.vehicle_order_code = quarel.vehicle_order_code
left join
	(
        select
          goods_id,
          count(user_id) as fav_cnt
        from
          db_youliangpai.yl_member_favorites_info
        final	
        where
          `_sign` = 1
          and favorite_type = 1
          and is_deleted = 0
          and goods_id is not null
        group by
          goods_id
	) favourite--关注表
on auction_goods.id =  favourite.goods_id
left join 
	(
		select 
			goods_id,
			vehicle_tag,
			transfer_requirements
		from 
			db_youliangpai.yl_member_car_info 
		final 
		where `_sign`=1
	) v_tag--辆典车
on v_tag.goods_id=auction_goods.id
left join auction_user_cnt
on auction_user_cnt.vehicle_auction_id = auction_goods.id
left join
	(
		select
			member_id,
			member_name,
			membership,
			director_name member_director,
			service_centre_name,
			member_mobile_phone,--会员手机号
			id_number,--身份证号
			free_margin,
			freeze_margin,
			total_margin_amount
		from syncdb.dim_yl_member_tmp
	) mem--会员维度
on mem.member_id = order_t.member_id
left join
	(
		select
			distributor_id,distributor,distributor_code,distributor_province_name,distributor_city_name,distributor_brand,
			created_time,group_id,created_time distributor_created_time,host_manufacturer_id,first_valid_auction_time,distributor_full_name,
			third_distributor_code,is_delivery_money_value,service_centre_name
		from syncdb.dim_yl_distributor_tmp
		where is_deleted=0
	) distributor--委托方维度
on auction_goods.distributor_id = distributor.distributor_id
left join
	(
		select
			group_id,group_name
		from
			syncdb.dim_yl_group_tmp
		where is_deleted=0
	) group_t--集团维度
on distributor.group_id = group_t.group_id
left join
	(
		select
			group_id,group_name
		from
			syncdb.dim_yl_group_tmp
		where is_deleted=0
	) host--主机厂
on distributor.host_manufacturer_id = host.group_id
left join
	(
		select
			centre_id,centre_name,centre_type,contact_name centre_contact_name
		from syncdb.dim_yl_centre_tmp
		where is_deleted = 0
	) centre--中心维度
on auction_goods.service_centre_id = centre.centre_id
left join
	(
		select
			vehicle_id,
			vehicle_code,
			vin_code,
			vehicle_plate_number,
			vehicle_brand,
			vehicle_series,
			vehicle_series_code,
			vehicle_name,
			vehicle_kilometers,
			transfer_count,
			vehicle_energy_type,
			vehicle_displacement,
			vehicle_source,
			vehicle_nature,
			vehicle_used_type,
			estimated_price,
			vehicle_registration_date,
			vehicle_manufacturing_date,
			vehicle_trafficinsurance_date,
			vehicle_commercial_insurance_date,
			vehicle_annual_inspection_date,
			vehicle_belong_city,
			vehicle_belong_province,
			vehicle_location_city,
			vehicle_location_province,
			free_worry_detection,
			report_rating,
			vehicle_detection_method,
			starting_price,
			end_price,
			report_url,
			appraiser,
			is_major_accident,
			manufacturers,
			create_time,
			create_id,
			three_way_catalyst_value
		from
			syncdb.dim_yl_vehicle_tmp
	) vehicle-- 车辆维度
on auction_goods.vehicle_code=vehicle.vehicle_code
left join
	(
		select *
		from
			(
				select
					collection_number,
					collection_number collection_code,
					payment_time,
					pay_type,
					modified_time payment_modified_time,
					amount_received,--收款
					transfer_date,--运营点实际收款
					row_number() over(partition by collection_number order by id) rk
				from db_mp_order.payment_order
				final
	    		where _sign = 1
			) pay1
		where rk = 1
	) pay--支付
on order_t.collection_number = pay.collection_number
--left join
--	(
--		select 
--			case when bank_name='苏州辙远信息科技有限公司' then bank_name
--                 else '其他'
--            end as client_name--开户名称
--            ,client_id
--		from db_youliangpai.yl_client_ping_relevance
--		final
--		where _sign=1 and status=0 and is_deleted=0 
--		group by 
--			case when bank_name='苏州辙远信息科技有限公司' then bank_name
--		    else '其他' end 
--		    ,client_id
--	) client
--on auction_goods.distributor_id = client.client_id
left join
	(
		select
			center_id,
			agency_id,
          	delivery_fee,--应收
          	settle_accounts_fee-- 结算
    	from import_data_db.center_delivery_fee_rule_new
	) settle_accounts_fee--交付费结算金额
on auction_goods.service_centre_id = settle_accounts_fee.center_id
and agent.agency_id = settle_accounts_fee.agency_id
left join
	(
		select
			goods_id
			,max(if(fee_type=1,goods_fee,0)) `交付费`
		from db_youliangpai.yl_auction_goods_fee_info
		final
		where _sign=1 and fee_type=1--交付费
		group by goods_id
	) fee
on auction_goods.id = fee.goods_id
left join
	(
		select
			id,dict_label
		from
			(
				SELECT
					toInt32(`dict_value`) id,dict_label
				from db_youliangpai.yl_sys_dict_data final
				where `_sign` =1 and `dict_type`='VEHICLE_SOURCE_TYPE_OPTIONS' and `id_delete`=0--APPLY_SOURCE_OPTIONS
			)
		group by id,dict_label
		
	) v_source
on auction_goods.vehicle_data_sources = v_source.id
where toDate(case when auction_goods.goods_begin_time is null then session_t.auction_session_begin_time 
else auction_goods.goods_begin_time end) <> '2024-02-07'-- 2024-02-07为测试数据
and vehicle_auction_id not in (156916,88164)--成交价异常
and vehicle_auction_id not in (543121,543126,543267); -- 利星行测试车