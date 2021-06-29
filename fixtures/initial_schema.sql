create table page_views
(
    id integer not null
        primary key autoincrement,
    created_at datetime default CURRENT_TIMESTAMP not null,
    updated_at datetime default CURRENT_TIMESTAMP not null
);