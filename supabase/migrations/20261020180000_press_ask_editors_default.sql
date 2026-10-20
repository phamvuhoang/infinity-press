-- Press publishes classics and their translations. Most authors are no longer able to answer, and a
-- reply must never read as theirs, so reader questions are OFF unless an admin turns them on for an
-- author whose rights holder or estate will actually answer. Existing rows keep their setting; the
-- reply workflow itself is the editors' (the copy says so).
alter table public.authors alter column accepts_questions set default false;
