truncate public.loans, public.books restart identity;
insert into public.books (title, copies) values ('The Clockwork Garden', 2), ('A Map of Quiet Places', 1);
insert into public.loans (book_id, reader_label) values (2, 'Synthetic reader');
