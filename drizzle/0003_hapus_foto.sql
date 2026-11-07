CREATE TABLE "photo_deletions" (
	"storage_key" varchar(200) PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
