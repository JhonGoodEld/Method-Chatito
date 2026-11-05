-- =====================================================================
-- MC-DB-000-MIGRACION-005.sql — Corrección diferida de errores fuera del alcance
-- Fuente: MC-001 v1.0.4 §7.5 · MC-002 v1.2.0 §16 · MC-OPERACIONAL v1.7.0
--
-- 1. Tabla errores_diferidos: SOLO los pendientes. Cada fila se borra cuando
--    el alumno corrige el error (la corrección queda en «evidencia»), así que
--    la tabla no crece sin límite.
-- 2. Contenido de EN-411 v1.0.1 en «livrables» (fronteras con identificadores
--    del grafo): el agente lee la lección desde aquí, no desde el repositorio.
--
-- Se puede ejecutar más de una vez sin efectos duplicados.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. errores_diferidos
-- ---------------------------------------------------------------------
create table if not exists errores_diferidos (
  id uuid primary key default gen_random_uuid(),
  alumno_idioma_id uuid not null references alumno_idioma(id) on delete cascade,
  propietario text not null,        -- id del grafo: lección (EN-412), sous-domaine (EN-410) o dominio (EN-500)
  unidad_origen text not null,      -- lección donde apareció el error
  fragmento text not null,
  correccion text not null,
  explicacion text not null default '',
  causa text,
  creado_en timestamptz not null default now(),
  constraint errores_diferidos_unico unique (alumno_idioma_id, unidad_origen, fragmento, correccion)
);
create index if not exists idx_errores_diferidos_alumno_propietario
  on errores_diferidos (alumno_idioma_id, propietario);

-- Mismo patrón que «evidencia»: el alumno lee lo suyo; solo el backend
-- (service role, que no pasa por RLS) inserta y borra.
alter table errores_diferidos enable row level security;
drop policy if exists "errores_diferidos_select_own" on errores_diferidos;
create policy "errores_diferidos_select_own"
  on errores_diferidos for select
  using (
    alumno_idioma_id in (
      select id from alumno_idioma where perfil_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- 2. EN-411 v1.0.1
-- ---------------------------------------------------------------------
update livrables
set contenido = $EN411$# EN-411 — Le pluriel régulier et irrégulier

| Champ | Valeur |
|---|---|
| **Document ID** | EN-411 |
| **Titre** | Le pluriel régulier et irrégulier |
| **Version** | 1.0.1 |
| **Status** | Brouillon — à valider |
| **Authors** | J. Good & Claude |
| **Date** | 01/10/2026 |
| **Domaine** | EN-400 — Système nominal |
| **Sous-domaine** | EN-410 — Morphologie nominale |
| **Prérequis** | EN-300 (transversal) |
| **Gabarit** | MC-001 v1.0.2 (étapes 8 à 19) |

> **Nature du document.** Ce livrable fixe le contenu **déclaratif** de la leçon : la règle, ses formes, ses exceptions, ses erreurs fréquentes et les formes d'évidence attendues. L'agent ne les modifie jamais. Les exemples, les exercices concrets et la manière d'expliquer sont **générés à chaque session** (MC-000, Principe 8) ; les exemples de l'étape 13 ne sont que des références.

## Objectif de la leçon (portée de la correction)

Former correctement le **pluriel des noms anglais**, réguliers et irréguliers, à l'écrit.

Seules les erreurs de formation du pluriel du nom relèvent de cette leçon. Les autres erreurs suivent le traitement hors portée de MC-001 §7.5 (correction dans cette leçon, observation puis correction différée, ou observation seule), selon leur propriétaire :

| Hors portée | Propriétaire |
|---|---|
| Noms indénombrables (*information*, *advice*, *furniture*) | EN-430 — Dénombrabilité |
| Articles et déterminants (*a / the / these*) | EN-420 — Déterminants et articles |
| Génitif (*the boys' room*) | EN-410 — Morphologie nominale (leçon suivante) |
| Accord sujet-verbe | EN-510 — Le verbe |
| Prononciation de *-s* (/s/, /z/, /ɪz/) | EN-170 — Règles phonologiques (transversal) |

## Étape 8 — Description grammaticale

En anglais, le nom variable a deux formes : **singulier** et **pluriel**. Le pluriel se forme :

- **régulièrement**, par l'ajout du suffixe *-s* (avec des ajustements orthographiques prévisibles) ;
- **irrégulièrement**, par un changement interne de voyelle, un suffixe ancien (*-en*), une forme identique au singulier (pluriel zéro) ou une forme empruntée (latin, grec).

L'adjectif anglais **ne prend jamais** la marque du pluriel : seul le nom varie.

## Étape 9 — Utilisation

- **Quand ?** Chaque fois qu'un nom dénombrable désigne plus d'une unité, ou zéro unité (*zero apples*, *no tickets*).
- **Pourquoi ?** Le pluriel porte l'information de quantité. Le nom en est le seul porteur dans le groupe nominal.
- **Registre :** identique à l'oral et à l'écrit, tous registres. Exception : *persons* (juridique, administratif) face à *people* (usage courant).
- **Particularités :** après un nombre, le nom est au pluriel dès 2 (*two cats*), mais un nom employé comme adjectif reste au singulier (*a ten-dollar bill*, *a three-year-old girl*). *Hundred*, *thousand* et *million* précédés d'un nombre ne prennent pas de *-s* (*two hundred people*).

## Étape 10 — Structure

**Règles régulières (ordre de vérification) :**

| Terminaison du singulier | Règle | Exemple de référence |
|---|---|---|
| Cas général | + *s* | *book → books* |
| *-s, -ss, -sh, -ch, -x, -z* | + *es* | *bus → buses*, *box → boxes*, *quiz → quizzes* |
| Consonne + *y* | *y* → *ies* | *city → cities* |
| Voyelle + *y* | + *s* | *day → days*, *key → keys* |
| Consonne + *o* | + *es* pour une liste fermée, sinon + *s* | *potato → potatoes* / *photo → photos* |
| *-f / -fe* | *-ves* pour une liste fermée, sinon + *s* | *knife → knives* / *roof → roofs* |

**Les quatre formes obligatoires (MC-001 §10) :** le pluriel du nom **ne change pas** selon le type de phrase. Ce qui change, c'est l'accord du verbe (hors portée).

1. **Affirmative :** *The boxes are heavy.*
2. **Négative :** *The boxes aren't heavy.*
3. **Interrogative :** *Are the boxes heavy?*
4. **Variantes :** pluriels doubles admis (*scarfs / scarves*, *zeros / zeroes*, *cactuses / cacti*), et registre *persons / people* (étape 9).

## Étape 11 — Expressions fréquentes

- **Signal words** (exigent un nom au pluriel) : *two, three… ; many, several, few, a few, both, these, those, a lot of, lots of, plenty of, a couple of, all the, most*.
- **Expressions figées au pluriel :** *thanks*, *congratulations*, *best wishes*, *ladies and gentlemen*, *in the twenties*.
- **Locutions :** *to be all ears*, *to have butterflies in one's stomach*, *it's raining cats and dogs*, *to take steps*.

## Étape 12 — Erreurs fréquentes

| Erreur | Forme correcte | Cause probable (MC-002 §15) |
|---|---|---|
| *childs*, *mans*, *foots*, *mouses* | *children*, *men*, *feet*, *mice* | Généralisation excessive de *-s* |
| *sheeps*, *fishs*, *deers* | *sheep*, *fish*, *deer* | Généralisation excessive (pluriel zéro ignoré) |
| *boxs*, *watchs*, *dishs* | *boxes*, *watches*, *dishes* | Connaissance partielle (règle *-es*) |
| *babys*, *citys* | *babies*, *cities* | Connaissance partielle (règle *y → ies*) |
| *keies*, *daies* | *keys*, *days* | Généralisation excessive de *y → ies* |
| *knifes*, *wifes* | *knives*, *wives* | Connaissance partielle (liste *-ves*) |
| *rooves*, *chieves* | *roofs*, *chiefs* | Généralisation excessive de *-ves* |
| *peoples* au sens de « des gens » | *people* | Interférence (fr. *personnes*, esp. *personas*) |
| *the reds cars* | *the red cars* | Interférence (accord de l'adjectif en français et en espagnol) |
| *two hundreds people* | *two hundred people* | Interférence (fr. *deux cents*) |

## Étape 13 — Exemples (référence)

L'agent génère **au moins 5 exemples nouveaux** à chaque session (MC-001 §13), dans des contextes variés. Ceux-ci servent seulement de référence :

1. *Two buses stopped in front of the churches.* (*-es*)
2. *The babies were playing with their toys.* (*y → ies* / voyelle + *y*)
3. *Our neighbours have three children and two dogs.* (irrégulier *-en* + régulier)
4. *I saw some sheep and a few deer near the river.* (pluriel zéro)
5. *Be careful: the knives are on the shelves.* (*-ves*)

## Étape 14 — Notes et exceptions

**Pluriels irréguliers à mémoriser :**

| Type | Liste |
|---|---|
| Changement de voyelle | *man → men, woman → women, foot → feet, tooth → teeth, goose → geese, mouse → mice, louse → lice* |
| Suffixe *-en* | *child → children, ox → oxen* |
| Pluriel zéro | *sheep, deer, fish, species, series, aircraft, means* |
| Supplétif | *person → people* (*persons* : registre juridique) |
| Emprunts | *cactus → cacti, fungus → fungi, analysis → analyses, crisis → crises, criterion → criteria, phenomenon → phenomena* |

**Listes fermées :**
- **Consonne + *o* → *-oes*** : *potatoes, tomatoes, heroes, echoes, vetoes*. Les autres prennent *-s* : *photos, pianos, radios, zoos, videos, kilos, memos*.
- ***-f / -fe* → *-ves*** : *knife, wife, life, leaf, half, wolf, shelf, loaf, thief, calf, self*. Les autres prennent *-s* : *roofs, chiefs, chefs, beliefs, cliffs, proofs*.

**Cas particuliers :**
- *Fish* : *fishes* uniquement pour désigner plusieurs **espèces**.
- Noms composés : le pluriel porte sur le nom principal (*mothers-in-law, passers-by*). Exception usuelle : *grown-ups*.
- **Pluralia tantum** (toujours au pluriel) : *scissors, trousers, jeans, glasses, pyjamas, clothes*. On les compte avec *a pair of*.

**Nuance :** *people* est déjà un pluriel (*people are*). *Peoples* existe, mais signifie « des peuples ».

**Transformations prévues** *(déclaratif, exécutées à l'étape 18)* :
1. Singulier → pluriel d'une phrase complète (*This child is tired → These children are tired*). Seul le pluriel du nom est évalué.
2. Pluriel → singulier (passage inverse).
3. Ajout d'un quantificateur (*a box → many boxes*, *one foot → both feet*).

> L'enchaînement de temps de MC-001 §18 (*Présent → Passé composé…*) est propre au français. Pour cette leçon nominale, la transformation porte sur le **nombre**, pas sur le temps.

## Étape 15 — Exercices guidés

- **Niveau 1 — Transformation :** mettre au pluriel des noms ou groupes nominaux fournis.
- **Niveau 2 — Phrases :** construire des phrases à partir d'éléments donnés (un nombre ou un quantificateur et un nom au singulier).
- **Niveau 3 — Production libre :** écrire librement, sans support, des phrases contenant des pluriels réguliers **et** irréguliers.

**Formes d'évidence attendues** *(déclaratif, obligatoire)* :

| Niveau | Évidence exigée |
|---|---|
| 1 | Réponse écrite courte : la forme plurielle de chaque item. |
| 2 | Phrase complète rédigée par l'apprenant pour chaque item. |
| 3 | Production libre écrite (texte ou photo d'une production manuscrite) d'au moins 5 phrases, dont au moins 2 pluriels irréguliers. |

## Étape 16 — Production écrite

**Critère fixe :** un texte court (environ 100 mots) sur un sujet du quotidien, dans lequel les pluriels apparaissent **naturellement**. La consigne ne doit pas forcer artificiellement leur emploi (MC-001 §16).

Le sujet est choisi par l'agent à chaque session. Pistes : décrire sa famille, sa maison, un marché, sa ville, un zoo.

## Étape 17 — Correction détaillée

La correction s'effectue contre les règles des étapes 10, 12 et 14, **dans la portée définie en tête de document**, selon les trois phases de MC-001 §17 : collecte d'évidence, correction différée, diagnostic.

## Étape 18 — Transformation

Exécution, avec l'apprenant, des transformations prévues à l'étape 14, sur les phrases qu'il a lui-même produites dans la leçon.

## Étape 19 — Vocabulaire

Thème : **la maison et la vie quotidienne**. Liste fixe, indépendante de la règle (MC-001 §19 ; suivi selon MC-005) :

*kitchen, bedroom, window, door, chair, table, bed, cup, plate, spoon, towel, clock, key, light, wall*

## Historique des versions

| Version | Date | Description |
|---|---|---|
| 1.0.0 | 01/10/2026 | Rédaction du livrable (l'original mentionné dans EN-000 v1.0.0 n'a pas été conservé dans le dépôt). Brouillon à valider par J. Good. |
| 1.0.1 | 04/11/2026 | Frontières : chaque propriétaire est désigné par son identifiant de l'architecture (MC-001 v1.0.4, §7.5). Retour à l'état Brouillon jusqu'à nouvelle validation (MC-001 §7.6). |
$EN411$,
    version = '1.0.1',
    actualizado_en = now()
where unidad_id = 'EN-411';

-- Verificación (opcional): debe devolver 1 fila con version 1.0.1 y «EN-510» en las fronteras
-- select unidad_id, version, position('EN-510' in contenido) > 0 as fronteras_ok
-- from livrables where unidad_id = 'EN-411';
