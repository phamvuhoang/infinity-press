begin;
select plan(3);
select lives_ok($$insert into public.operations_alert_state (rule_name) values ('stale_reader_question') on conflict (rule_name) do nothing$$, 'the rule name is accepted');
select results_eq($$select count(*) from public.operations_alert_state where rule_name = 'stale_reader_question'$$, array[1::bigint], 'the row is seeded');
select throws_ok($$insert into public.operations_alert_state (rule_name) values ('not_a_rule')$$, '23514', null, 'an unknown rule name is still rejected');
select * from finish();
rollback;
