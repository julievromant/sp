import { createClient } from '@supabase/supabase-js';

export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return new Response(JSON.stringify({ 
            status: 'error', 
            message: 'Configuration serveur incomplète : SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.' 
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const body = await request.json().catch(() => ({}));
        const { action, ...payload } = body;
        let result = { status: 'success' };

        const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

        switch (action) {
            case 'get_data': {
                // Récupération des événements
                const { data: events, error: evErr } = await supabase.from('events').select('*');
                if (evErr) console.error("Erreur lecture events:", evErr);
                
                // Récupération des utilisateurs
                const { data: users, error: usErr } = await supabase.from('users').select('*');
                if (usErr) console.error("Erreur lecture users:", usErr);

                // Récupération des missions de la table dédiée
                const { data: missions, error: missErr } = await supabase.from('missions').select('*');
                if (missErr) console.error("Erreur lecture missions:", missErr);

                // Récupération des inscriptions de la table dédiée
                const { data: registrations, error: regErr } = await supabase.from('registrations').select('*');
                if (regErr) console.error("Erreur lecture registrations:", regErr);

                // Reconstruction des données imbriquées pour l'application
                const formattedEvents = (events || []).map(evt => {
                    const evtMissions = (missions || [])
                        .filter(m => String(m.event_id) === String(evt.id))
                        .map(m => {
                            const volunteers = (registrations || [])
                                .filter(r => String(r.mission_id) === String(m.id))
                                .map(r => ({ email: r.user_email, name: r.user_name }));

                            return {
                                id: m.id,
                                title: m.title,
                                type: m.type,
                                details: m.details,
                                estimatedHours: m.estimated_hours,
                                maxVolunteers: m.max_volunteers,
                                volunteers: volunteers
                            };
                        });

                    return {
                        id: evt.id,
                        title: evt.title,
                        organizer: evt.organizer,
                        type: evt.type,
                        date: evt.date,
                        prepMonth: evt.prep_month || evt.prepMonth,
                        location: evt.location,
                        description: evt.description,
                        missions: evtMissions
                    };
                });
                
                result = { events: formattedEvents, users: users || [] };
                break;
            }

            case 'save_event': {
                const { event } = payload;
                
                // 1. Sauvegarder ou mettre à jour l'événement (sans les missions dans la table events)
                const eventPayload = {
                    id: String(event.id),
                    title: event.title,
                    organizer: event.organizer,
                    type: event.type,
                    date: event.date,
                    prep_month: event.prepMonth,
                    location: event.location,
                    description: event.description
                };

                const { error: evtErr } = await supabase.from('events').upsert(eventPayload);
                if (evtErr) throw new Error("Erreur enregistrement événement: " + evtErr.message);

                // 2. Gestion des missions dans la table dédiée 'missions'
                if (Array.isArray(event.missions)) {
                    const missionIdsToKeep = event.missions.map(m => String(m.id));

                    // Supprimer les missions qui n'existent plus pour cet événement
                    if (missionIdsToKeep.length > 0) {
                        const { data: existingMissions } = await supabase
                            .from('missions')
                            .select('id')
                            .eq('event_id', String(event.id));

                        const toDelete = (existingMissions || [])
                            .filter(m => !missionIdsToKeep.includes(m.id))
                            .map(m => m.id);

                        if (toDelete.length > 0) {
                            await supabase.from('registrations').delete().in('mission_id', toDelete);
                            await supabase.from('missions').delete().in('id', toDelete);
                        }
                    } else {
                        // Si aucune mission n'est fournie, tout supprimer pour cet événement
                        const { data: existingMissions } = await supabase
                            .from('missions')
                            .select('id')
                            .eq('event_id', String(event.id));
                        
                        const toDelete = (existingMissions || []).map(m => m.id);
                        if (toDelete.length > 0) {
                            await supabase.from('registrations').delete().in('mission_id', toDelete);
                            await supabase.from('missions').delete().eq('event_id', String(event.id));
                        }
                    }

                    // Insérer / Mettre à jour les missions
                    for (const m of event.missions) {
                        const missionPayload = {
                            id: String(m.id),
                            event_id: String(event.id),
                            title: m.title,
                            type: m.type || 'precise',
                            details: m.details,
                            estimated_hours: parseFloat(m.estimatedHours || 2),
                            max_volunteers: parseInt(m.maxVolunteers || 2)
                        };

                        const { error: missErr } = await supabase.from('missions').upsert(missionPayload);
                        if (missErr) throw new Error("Erreur enregistrement mission: " + missErr.message);
                    }
                }

                break;
            }

            case 'delete_event': {
                const eventId = String(payload.eventId);

                // 1. Récupérer les ids des missions associées
                const { data: eventMissions } = await supabase
                    .from('missions')
                    .select('id')
                    .eq('event_id', eventId);

                const missionIds = (eventMissions || []).map(m => m.id);

                // 2. Supprimer les inscriptions associées aux missions
                if (missionIds.length > 0) {
                    await supabase.from('registrations').delete().in('mission_id', missionIds);
                }

                // 3. Supprimer les missions
                await supabase.from('missions').delete().eq('event_id', eventId);

                // 4. Supprimer l'événement
                const { error } = await supabase.from('events').delete().eq('id', eventId);
                if (error) throw new Error("Erreur suppression événement: " + error.message);

                break;
            }

            case 'toggle_signup': {
                const { eventId, missionId, email, name } = payload;
                const cleanEmail = (email || '').trim().toLowerCase();

                // Vérifier si l'inscription existe déjà
                const { data: existing } = await supabase
                    .from('registrations')
                    .select('id')
                    .eq('mission_id', String(missionId))
                    .eq('user_email', cleanEmail)
                    .maybeSingle();

                if (existing) {
                    const { error } = await supabase
                        .from('registrations')
                        .delete()
                        .eq('id', existing.id);
                    if (error) throw new Error("Erreur annulation inscription: " + error.message);
                    result = { status: 'success', action: 'removed' };
                } else {
                    const { error } = await supabase
                        .from('registrations')
                        .insert([{
                            event_id: String(eventId),
                            mission_id: String(missionId),
                            user_email: cleanEmail,
                            user_name: name
                        }]);
                    if (error) throw new Error("Erreur validation inscription: " + error.message);
                    result = { status: 'success', action: 'added' };
                }
                break;
            }

            case 'check_email': {
                const email = (payload.email || '').trim().toLowerCase();
                const { data, error } = await supabase.from('users').select('email').eq('email', email).maybeSingle();
                if (error) console.error("Erreur check_email:", error);
                result = { exists: !!data };
                break;
            }

            case 'send_magic_link': {
                const email = (payload.email || '').trim().toLowerCase();
                const firstname = payload.firstname || 'Parent';
                const lastname = payload.lastname || 'Bénévole';
                const kidsClasses = payload.kidsClasses || 'CP';

                if (payload.isNew) {
                    await supabase.from('users').upsert({
                        email: email,
                        firstname: firstname,
                        lastname: lastname,
                        kids_classes: kidsClasses,
                        is_admin: email === 'marie.parent@apel.fr'
                    }, { onConflict: 'email' });
                }

                const redirectUrl = new URL(request.url).origin + '/';
                const { error } = await supabase.auth.signInWithOtp({
                    email: email,
                    options: {
                        emailRedirectTo: redirectUrl,
                        data: { firstname, lastname, kids_classes: kidsClasses }
                    }
                });

                if (error) throw new Error(error.message);
                result = { status: 'success', message: 'Lien magique envoyé avec succès.' };
                break;
            }

            case 'verify_magic_link': {
                const code = payload.code;
                const hash = payload.hash;

                if (!code && (!hash || !hash.includes('access_token'))) {
                    throw new Error("Paramètres d'authentification manquants.");
                }

                let authUser = null;

                if (code) {
                    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
                    if (sessionError || !sessionData?.user) throw new Error(sessionError?.message || "Échec échange du code PKCE.");
                    authUser = sessionData.user;
                } else if (hash) {
                    const params = new URLSearchParams(hash.replace(/^#/, ''));
                    const accessToken = params.get('access_token');
                    if (accessToken) {
                        const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
                        if (!userErr && userData) authUser = userData.user;
                    }
                }

                if (!authUser) throw new Error("Utilisateur introuvable.");

                const email = authUser.email.toLowerCase();
                const metadata = authUser.user_metadata || {};

                let { data: dbUser } = await supabase.from('users').select('*').eq('email', email).maybeSingle();

                if (!dbUser) {
                    const newUser = {
                        id: authUser.id,
                        email: email,
                        firstname: metadata.firstname || 'Parent',
                        lastname: metadata.lastname || 'Bénévole',
                        kids_classes: metadata.kids_classes || 'CP',
                        is_admin: email === 'marie.parent@apel.fr'
                    };
                    const { data: inserted, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
                    if (insertErr) throw new Error("Erreur création utilisateur: " + insertErr.message);
                    dbUser = inserted;
                }

                result = { status: 'success', user: dbUser };
                break;
            }

            default:
                throw new Error('Action inconnue: ' + action);
        }

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error("ERREUR PROXY:", error.message);
        return new Response(JSON.stringify({ 
            status: 'error', 
            message: error.message || 'Erreur interne du serveur' 
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}