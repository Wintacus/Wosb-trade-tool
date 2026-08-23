-- Reject impossible values at the database, not just in the app.
--
-- Found by probing the calculator with hostile input: a buy price of -10.0
-- gold made every good look enormously profitable, because a negative cost is
-- free money to the arithmetic. Nothing stopped such a row being stored.
--
-- The calculator is not the right place to catch this. A price arrives from
-- manual entry, from OCR, and later from screen capture, and any of those can
-- produce nonsense. One rule at the bottom covers all of them, and it cannot
-- be forgotten in a code path written later.
--
-- These are deliberately loose: they reject the impossible, not the merely
-- surprising. Judging whether a real price is plausible is what the min/max
-- bands and Phase 4 moderation are for.
--
-- Safe to run twice: each constraint is added only if it is not already there.

do $constraints$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      -- Money and quantities can be unknown, but never negative.
      ('price_submissions',      'price_buy_nonneg',      'buy_price is null or buy_price >= 0'),
      ('price_submissions',      'price_sell_nonneg',     'sell_price is null or sell_price >= 0'),
      ('price_submissions',      'price_stock_nonneg',    'stock is null or stock >= 0'),

      -- A tax rate outside 0..100 is not a rate. Observed real values run 4-12.
      ('port_state_submissions', 'port_tax_range',        'tax_percent is null or (tax_percent >= 0 and tax_percent <= 100)'),
      ('port_state_submissions', 'port_fee_nonneg',       'docking_fee is null or docking_fee >= 0'),
      -- Ship rates are 1 to 7. Anything else would silently gate every ship
      -- out of a port, or none of them.
      ('port_state_submissions', 'port_min_rate_range',   'min_ship_rate is null or (min_ship_rate >= 1 and min_ship_rate <= 7)'),
      ('port_state_submissions', 'port_level_nonneg',     'port_level is null or port_level >= 0'),

      -- A good weighing nothing would let an unlimited quantity into the hold.
      ('goods',                  'goods_weight_positive', 'weight > 0'),
      ('goods',                  'goods_base_nonneg',     'base_value is null or base_value >= 0'),
      ('goods',                  'goods_min_nonneg',      'min_price is null or min_price >= 0'),
      ('goods',                  'goods_max_nonneg',      'max_price is null or max_price >= 0'),

      ('ships',                  'ships_rate_range',      'rate >= 1 and rate <= 7'),
      ('ships',                  'ships_hold_positive',   'hold > 0')
    ) as t(table_name, constraint_name, check_expression)
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = wanted.constraint_name
         and conrelid = wanted.table_name::regclass
    ) then
      execute format(
        'alter table %I add constraint %I check (%s)',
        wanted.table_name, wanted.constraint_name, wanted.check_expression
      );
    end if;
  end loop;
end $constraints$;
