WITH u1 AS (SELECT uid cpid FROM his_db.ctv_user WHERE imp_date='2024')
INSERT OVERWRITE TABLE sum_db.b10_info_cpid PARTITION(data_dt='2024')
SELECT u1.cpid FROM u1;
